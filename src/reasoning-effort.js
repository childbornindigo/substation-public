const REQUEST_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'max']);

export function normalizeReasoningEffort(value) {
  if (typeof value !== 'string') return null;
  const effort = value.trim().toLowerCase();
  return REQUEST_REASONING_EFFORTS.has(effort) ? effort : null;
}

function firstValidReasoningEffort(...values) {
  for (const value of values) {
    const effort = normalizeReasoningEffort(value);
    if (effort) return effort;
  }
  return null;
}

export function resolveRequestedReasoningEffort(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return null;
  const extraBody = requestBody.extra_body && typeof requestBody.extra_body === 'object'
    ? requestBody.extra_body
    : {};
  const reasoning = requestBody.reasoning && typeof requestBody.reasoning === 'object'
    ? requestBody.reasoning
    : {};
  const extraReasoning = extraBody.reasoning && typeof extraBody.reasoning === 'object'
    ? extraBody.reasoning
    : {};
  const outputConfig = requestBody.output_config && typeof requestBody.output_config === 'object'
    ? requestBody.output_config
    : {};
  const extraOutputConfig = extraBody.output_config && typeof extraBody.output_config === 'object'
    ? extraBody.output_config
    : {};
  return firstValidReasoningEffort(
    requestBody.reasoning_effort,
    reasoning.effort,
    extraBody.reasoning_effort,
    extraReasoning.effort,
    outputConfig.effort,
    extraOutputConfig.effort,
  );
}

export function resolveClaudeReasoningEffort(requestedEffort) {
  const requestEffort = normalizeReasoningEffort(requestedEffort);
  return { effort: requestEffort || 'high', source: requestEffort ? 'request' : 'default' };
}

export function resolveCodexReasoningEffort(requestedEffort, modelInfo = {}) {
  const requestEffort = normalizeReasoningEffort(requestedEffort);
  if (requestEffort) return { effort: requestEffort, source: 'request' };
  const tableEffort = normalizeReasoningEffort(modelInfo.reasoningEffort);
  return { effort: tableEffort, source: 'default' };
}
