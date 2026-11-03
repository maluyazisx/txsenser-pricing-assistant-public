"""Private reference inquiries; no price qualification or shared-history writes."""
from copy import deepcopy
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import re

from .product_pricing_contracts import CONTRACT_VERSION, HistoricalPricingQuery, ReadEnvelope
from .product_pricing_read_zh import present_read_result_zh, _STAGES

FIELDS = ('customer_id', 'project_id', 'product_id', 'market', 'application', 'role',
          'quantity', 'currency', 'unit', 'conditions')
LABELS = dict(zip(FIELDS, ('客户', '项目', '产品配置', '市场', '应用', '价格类型',
                         '数量', '币种', '单位', '商业条件')))
HISTORY_MESSAGES = {
    'not_connected': '共享报价历史尚未接通；当前可核对来源参考与询价条件。',
    'identity_unresolved': '客户、项目或产品配置关联尚未确认；未查询该范围历史。',
    'unavailable': '共享历史暂时不可用，本次未完成核对。',
    'ready_empty': '本次查询时点和范围内未返回可参考历史。',
    'ready_records': '已取得历史参考；条件不同不自动沿用金额。',
}


class InquiryRejected(ValueError):
    pass


def history_state(status, **extra):
    return dict(status=status, message=HISTORY_MESSAGES[status], records=[], **extra)


def normalize_terms(terms):
    if not isinstance(terms, dict) or any(k not in FIELDS for k in terms):
        raise InquiryRejected('询价条件格式无效。')
    clean = {k: terms.get(k, '') for k in FIELDS}
    if any(not isinstance(v, str) or len(v) > (1000 if k == 'conditions' else 100)
           for k, v in clean.items()):
        raise InquiryRejected('询价条件内容过长或格式无效。')
    if clean['quantity'] and not re.fullmatch(r'[1-9]\d{0,4}', clean['quantity']):
        raise InquiryRejected('本次询价数量须为1–99999的整数；未明确时可留空。')
    return clean


class C1HistoryReadAdapter:
    """Explicitly injected C1 reader, never a loader or a writer.

    scopes is an already authorized mapping from (account, opportunity, local
    product) to (canonical product, configuration). No name/PN fallback.
    There is deliberately no CLI, directory discovery or default real binding.
    """
    def __init__(self, reader, *, scopes, publication_id, publication_digest, shared_history=None,
                 coverage_confirmed=False):
        self.reader = reader
        self.scopes = deepcopy(scopes)
        self.publication_id = publication_id
        self.publication_digest = publication_digest
        self.coverage_confirmed = coverage_confirmed
        self.shared_history = shared_history

    def read(self, terms, as_of):
        identity = (terms['customer_id'], terms['project_id'], terms['product_id'])
        target = self.scopes.get(identity)
        if (not identity[0] or not target or self.shared_history is None
                or identity[0] not in self.shared_history.account_ids
                or (identity[1] and dict(self.shared_history.opportunity_accounts).get(identity[1]) != identity[0])):
            return history_state('identity_unresolved')
        if not self.coverage_confirmed or not self.publication_id or not self.publication_digest:
            return history_state('unavailable')
        try:
            result = self.reader.historical_pricing_lookup(HistoricalPricingQuery(
                as_of=as_of, customer_id=identity[0], opportunity_id=identity[1] or None,
                product_id=target[0], configuration_id=target[1]))
            if (not isinstance(result, ReadEnvelope) or result.contract_version != CONTRACT_VERSION
                    or result.brain_publication_id != self.publication_id
                    or result.brain_publication_digest != self.publication_digest
                    or result.as_of != as_of
                    or not result.knowledge_as_of or result.freshness == 'no_projection'
                    or result.execution_allowed):
                return history_state('unavailable')
            if result.match_status == 'blocked' and any('shared_identity_link_unresolved' in x.get('reasons', []) for x in result.unknown):
                return history_state('identity_unresolved')
            if result.match_status not in ('exact', 'partial', 'not_found'):
                return history_state('unavailable')
            if not result.historical and not (result.match_status == 'not_found' and any(
                    set(x.get('reasons', [])) & {'no_record', 'retracted'} for x in result.unknown)):
                return history_state('unavailable')
            status = 'ready_records' if result.historical else 'ready_empty'
            response = history_state(status, as_of=result.as_of,
                knowledge_as_of=result.knowledge_as_of, publication_id=result.brain_publication_id,
                publication_digest=result.brain_publication_digest,
                publication_status=result.publication_status, match_status=result.match_status,
                queried_scope=dict(customer_id=identity[0], project_id=identity[1],
                                   product_id=target[0], configuration_id=target[1]))
            response['records'] = deepcopy(list(result.historical))
            response['detail'] = present_read_result_zh(result)
            return response
        except Exception:
            # Never turn provider errors into absence, or expose private paths/errors.
            return history_state('unavailable')


REFERENCE_FIELDS = ('publication_id', 'publication_digest', 'record_id',
                    'revision_id', 'revision_digest', 'stage_fact_id')


def exact_reference(value):
    if (not isinstance(value, dict) or set(value) != set(REFERENCE_FIELDS)
            or any(not isinstance(value[k], str) or not 1 <= len(value[k]) <= 256
                   for k in REFERENCE_FIELDS)):
        raise InquiryRejected('历史依据标识不完整，请重新读取后选择。')
    return {key: value[key] for key in REFERENCE_FIELDS}


def reference_options(history):
    """Only identities actually returned by the already scoped read, never amounts."""
    if history.get('status') != 'ready_records':
        return []
    options = []
    for record in history.get('records', []):
        for fact in record.get('stage_facts', []):
            if (fact.get('stage_kind') in ('historical_fact_corrected', 'historical_fact_retracted', 'applicability_superseded')
                    or fact.get('current_applicability') in ('corrected', 'retracted')):
                continue
            try:
                reference = exact_reference(dict(publication_id=history.get('publication_id'),
                    publication_digest=history.get('publication_digest'), record_id=record.get('record_id'),
                    revision_id=record.get('revision_id'), revision_digest=record.get('revision_digest'),
                    stage_fact_id=fact.get('stage_fact_id')))
            except InquiryRejected:
                continue
            label = [_STAGES.get(fact.get('stage_kind'), '历史记录'), str(fact.get('occurred_at') or '日期未提供')]
            nature = {'total_received': '收款总额', 'unit_price': '历史单价', 'total': '记录总额'}.get(fact.get('amount_nature'), '记录金额')
            try:
                amount = Decimal(str(fact.get('amount')))
                if not amount.is_finite(): raise InvalidOperation()
                rounded = amount.quantize(Decimal('1'), rounding=ROUND_HALF_UP)
                label.append(nature+('约 ' if rounded != amount else ' ')+format(rounded, ',f')+' '+str(fact.get('currency') or '币种未提供'))
            except (InvalidOperation, ValueError):
                label.append('金额未提供')
            customer = record.get('customer_link', {}).get('literal')
            if isinstance(customer, str) and customer: label.append(customer)
            options.append(dict(reference=reference, label=' · '.join(label)))
    # An ambiguous repeated identity is not a selectable reference.
    return [item for item in options if sum(x['reference'] == item['reference'] for x in options) == 1]


def select_history_reference(request, history, proposed):
    reference = exact_reference(proposed)
    if not request or not any(item['reference'] == reference for item in reference_options(history)):
        raise InquiryRejected('这条依据未在本次授权查询中返回，未保存。请重新核对后选择。')
    return dict(schema='private-history-reference.v1', reference=reference,
        context=dict(inquiry_request=deepcopy(request), queried_scope=deepcopy(history['queried_scope'])),
        selected_as_of=history['as_of'], knowledge_as_of=history['knowledge_as_of'])


def history_reference_state(request, saved, history, checked_as_of):
    result = dict(status='none', message='', options=reference_options(history),
                  saved=deepcopy(saved), checked_as_of=checked_as_of)
    if not saved:
        return result
    def outcome(status, message):
        return dict(result, status=status, message=message)
    if saved.get('context', {}).get('inquiry_request') != request:
        return outcome('context_changed', '询价条件或身份已变化；原引用保留，不作为本次询价依据。')
    connection = history.get('status')
    if connection == 'not_connected':
        return outcome('not_connected', '历史尚未接通；原引用保留，暂未重新核对。')
    if connection not in ('ready_records', 'ready_empty'):
        return outcome('unavailable', '暂时无法核对原依据；不能确认仍适用。')
    if saved['context'].get('queried_scope') != history.get('queried_scope'):
        return outcome('scope_changed', '历史读取范围已变化；原引用保留，不自动沿用。')
    reference = saved['reference']
    # Only a returned, target-specific fact proves correction/withdrawal. Empty
    # results (including C1's overloaded "retracted" reason) do not prove either.
    for record in history.get('records', []):
        if record.get('record_id') != reference['record_id']:
            continue
        for fact in record.get('stage_facts', []):
            if fact.get('predecessor_fact_ref') == reference['stage_fact_id']:
                if fact.get('stage_kind') == 'historical_fact_retracted':
                    return outcome('withdrawn', '已查到这条原依据的撤回记录；原引用保留，不能继续沿用。')
                if fact.get('stage_kind') == 'historical_fact_corrected':
                    return outcome('changed', '已查到这条原依据的更正记录；原引用保留，请重新选择。')
    if any(item['reference'] == reference for item in result['options']):
        item = next(item for item in result['options'] if item['reference'] == reference)
        return dict(outcome('valid', '这条历史依据与保存时一致，可供本次询价参考；不代表正式报价。'), label=item['label'])
    if (history.get('publication_id'), history.get('publication_digest')) != (reference['publication_id'], reference['publication_digest']):
        return outcome('changed', '历史资料版本已变化；原引用保留，请重新核对，不自动替换。')
    if any(record.get('record_id') == reference['record_id'] and
           (record.get('revision_id'), record.get('revision_digest')) != (reference['revision_id'], reference['revision_digest'])
           for record in history.get('records', [])):
        return outcome('changed', '这条历史依据的版本已变化；原引用保留，不自动替换。')
    return outcome('unavailable', '当前查询未返回这条原依据，不能确认仍适用，也不能据此判断已撤回。')


def analyze_reference(terms, rows, *, as_of, history_reader=None):
    clean = normalize_terms(terms)
    missing = [LABELS[k] for k in FIELDS if k not in ('customer_id', 'project_id', 'quantity') and not clean[k]]
    result = dict(kind='private_reference_inquiry', terms=clean, status='NEEDS_INFO',
        missing=missing, references=[], differences=[], reason='请补齐参考核对条件。',
        execution_allowed=False, history=history_state('not_connected' if history_reader is None else 'identity_unresolved'))
    if missing:
        return result
    keys = ('product_id', 'market', 'application', 'role', 'currency', 'unit')
    matches = [r for r in rows if all(r.get(k) == clean[k] for k in keys)]
    exact = [r for r in matches if r.get('conditions') == clean['conditions']]
    if exact:
        matches = exact
    if len(matches) != 1 or matches[0].get('baseline') is None:
        result.update(status='REFERENCE_MISSING', reason='未找到唯一来源参考；请核对所选配置及条件。')
        return result
    row = matches[0]
    result['references'] = [{k: deepcopy(row.get(k)) for k in (
        'id', 'product_id', 'configuration', 'baseline', 'role', 'market', 'application',
        'currency', 'unit', 'conditions', 'tier', 'min_quantity', 'max_quantity',
        'source', 'source_anchor', 'approval', 'effective')}]
    if row.get('conditions') != clean['conditions']:
        result['differences'].append('本次商业条件与来源不同，需另行核对。')
    if row.get('tier') == 'source_not_specified':
        result['differences'].append('来源未设固定数量分档；本次数量不自动形成批量适用或折扣。')
    elif clean['quantity'] and (type(row.get('min_quantity')) is not int or type(row.get('max_quantity')) is not int
            or not row['min_quantity'] <= int(clean['quantity']) <= row['max_quantity']):
        result['differences'].append('本次数量与来源数量范围不同或尚不能确认。')
    if not clean['quantity']:
        result['differences'].append('本次询价数量未填写；当前仅核对来源参考。')
    result.update(status='REFERENCE_ONLY', reason='已列出所选来源参考；询价条件已保存，不代表正式报价或已向客户报出。')
    if history_reader is not None:
        try:
            history = history_reader.read(clean, as_of)
            if not isinstance(history, dict) or history.get('status') not in HISTORY_MESSAGES:
                raise ValueError('invalid_history_result')
            result['history'] = history
        except Exception:
            result['history'] = history_state('unavailable')
    return result
