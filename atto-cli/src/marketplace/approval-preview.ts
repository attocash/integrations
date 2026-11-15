import { normalizeDisputeText, normalizeEvidenceUrls, type MarketplaceProofApprovalPreview } from './proof-approval.js';

export function formatMarketplaceApprovalPreview(preview: MarketplaceProofApprovalPreview): string {
  const action = preview.action;
  const command = action.command && typeof action.command === 'object' ? action.command as Record<string, unknown> : {};
  const fields = [
    `Marketplace: ${preview.marketplaceOrigin}`,
    `Transport: ${preview.transport}`,
    `Proof origin: ${preview.proofOrigin ?? '(none; Agent API audience)'}`,
    `Audience: ${preview.audience}`,
    `Purpose: ${preview.purpose}`,
    `Controller: Atto index ${preview.controller.index}, ${preview.controller.address}`,
    ...(preview.accountId ? [`Account: ${preview.accountId}`, `Identity: ${preview.identityId}`] : []),
    `Challenge: ${preview.challengeId}`,
    `Expires: ${preview.expiresAt}`,
  ];
  if (action.kind === 'credential') {
    const credential = command.credential && typeof command.credential === 'object' ? command.credential as Record<string, unknown> : {};
    fields.push(`Action: ${String(command.operation)} scoped credential`,
      ...(typeof credential.name === 'string' ? [`Name: ${credential.name.trim()}`] : []),
      ...(Array.isArray(credential.scopes) ? [`Scopes: ${credential.scopes.join(', ')}`] : []),
      ...(typeof command.targetApiKeyId === 'string' ? [`Credential ID: ${command.targetApiKeyId}`] : []));
    for (const [name, label] of [['publishAttoLimit','ATTO publish ceiling'],['publishXnoLimit','XNO publish ceiling']] as const) {
      if (typeof credential[name] === 'string') fields.push(`${label}: ${String(credential[name])} atomic units`);
    }
    if (Array.isArray(credential.scopes) && credential.scopes.includes('products:publish')) {
      for (const [name, label] of [['productPublishAttoLimit','ATTO product publication basis ceiling'],
        ['productPublishXnoLimit','XNO product publication basis ceiling']] as const) {
        fields.push(`${label}: ${typeof credential[name] === 'string' ? `${String(credential[name])} atomic units` : 'denied'}`);
      }
    }
    if (Array.isArray(credential.scopes) && credential.scopes.includes('products:purchase')) {
      for (const [name, label] of [['purchaseAttoLimit','ATTO product purchase ceiling'],['purchaseXnoLimit','XNO product purchase ceiling']] as const) {
        fields.push(`${label}: ${typeof credential[name] === 'string' ? `${String(credential[name])} atomic units` : 'denied'}`);
      }
    }
  } else if (action.kind === 'identity-link') {
    fields.push(`Action: link controller (${String(action.operation)})`,
      `Link ID: ${String(action.linkId)}`, `Authorizing identity: ${String(action.authorizingIdentityId)}`,
      `Authorizing address: ${String(action.authorizingAddress)}`, `New controller address: ${String(action.newIdentityAddress)}`);
  } else if (action.kind === 'identity-unlink') {
    fields.push('Action: unlink controller', `Controller to remove: ${String(action.targetIdentityId)}`,
      `Authorizing identity: ${String(action.authorizingIdentityId)}`);
  } else if (action.kind === 'adminModeration') {
    fields.push(`Action: ${String(action.action)} ${String(action.targetKind)}`, `Target: ${String(action.targetId)}`,
      `Target version: ${String(action.expectedTargetVersion)}`, `Moderation version: ${String(action.expectedModerationVersion)}`,
      `Reason: ${String(action.reason).replace(/^ +| +$/g, '')}`);
  } else if (action.kind === 'adminTaskClose') {
    fields.push(`Action: ${String(action.action)} task`, `Task: ${String(action.taskId)}`,
      `Expected version: ${String(action.expectedVersion)}`, `Reason: ${String(action.reason).replace(/^ +| +$/g, '')}`);
  } else if (action.kind === 'adminDisputeOpen') {
    fields.push('Action: administrator opens dispute', `Task: ${String(action.taskId)}`,
      `Engagement version: ${String(action.expectedEngagementVersion)}`, `Represented agent: ${String(action.representedAgentId)}`,
      `Reason: ${String(action.reason)}`, `Statement: ${terminalSafeValue(normalizeDisputeText(String(action.statement)))}`,
      `Evidence URLs: ${(normalizeEvidenceUrls(action.evidenceUrls) ?? []).map(terminalSafeValue).join(', ') || '(none)'}`,
      `Audit reason: ${terminalSafeValue(normalizeDisputeText(String(action.auditReason)))}`);
  } else if (action.kind === 'adminDisputeResolution') {
    fields.push('Action: administrator resolves dispute', `Dispute: ${String(action.disputeId)}`,
      `Dispute version: ${String(action.expectedDisputeVersion)}`, `Outcome: ${String(action.outcome)}`,
      `Rationale: ${terminalSafeValue(normalizeDisputeText(String(action.rationale)))}`);
  } else if (action.kind === 'login') {
    fields.push(`Action: create a controller session for ${String(action.address)}`);
  }
  const heading = 'Review this server-authored Marketplace wallet proof before signing:';
  return `${heading}\n${fields.map(field => `  ${escapeTerminalControls(field)}`).join('\n')}`;
}

function terminalSafeValue(value: string): string {
  return JSON.stringify(escapeTerminalControls(value));
}

function escapeTerminalControls(value: string): string {
  return [...value].map(character => {
    const point = character.codePointAt(0)!;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)
      || point === 0x2028 || point === 0x2029 || /\p{Cf}/u.test(character)) {
      return `\\u{${point.toString(16).toUpperCase()}}`;
    }
    return character;
  }).join('');
}
