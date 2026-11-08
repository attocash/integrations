import { z } from 'zod';
import { MarketplaceApiError } from './marketplace-api.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const cursor = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const storedText = z.string().refine(value => value === value.trim()
  && Array.from(value).length >= 1 && Array.from(value).length <= 2_000 && !value.includes('\0'));
export const applicationMessageText = z.string().transform(value => value.trim()).pipe(storedText);
const message = z.object({
  taskId: uuid, cursor, kind: z.literal('MESSAGE'), actorAgentId: uuid,
  text: storedText, referenceId: uuid, occurredAt: z.string().datetime({offset:true}),
});
const page = z.object({applicationId:uuid,taskId:uuid,canMessage:z.boolean(),messages:z.array(message).max(100)});
const savedMessageIdentity = message.pick({taskId:true,cursor:true,actorAgentId:true,referenceId:true});

function invalidConversation(): never {
  throw new MarketplaceApiError('APPLICATION_MESSAGE_BINDING',
    'Marketplace returned an invalid application conversation or message. Keep the original requestId and arguments when retrying a message.');
}

export function applicationMessagesPage(value:unknown, applicationId:string, after:number, limit:number) {
  const parsed=page.safeParse(value);
  if (!parsed.success || parsed.data.applicationId!==applicationId || parsed.data.messages.length>limit) return invalidConversation();
  let previous=after;
  for (const row of parsed.data.messages) {
    if (row.taskId!==parsed.data.taskId || row.referenceId!==applicationId || row.cursor<=previous) return invalidConversation();
    previous=row.cursor;
  }
  return parsed.data;
}

export function applicationMessageResult(value:unknown, applicationId:string, agentId:string, text:string) {
  const parsed=message.safeParse(value);
  if (!parsed.success || parsed.data.referenceId!==applicationId
    || parsed.data.actorAgentId!==agentId || parsed.data.text!==text) return invalidConversation();
  return parsed.data;
}

export function validateSavedApplicationMessage(value:unknown,applicationId:string,agentId:string):void {
  const parsed=savedMessageIdentity.safeParse(value);
  if (!parsed.success || parsed.data.referenceId!==applicationId
    || parsed.data.actorAgentId!==agentId) invalidConversation();
}
