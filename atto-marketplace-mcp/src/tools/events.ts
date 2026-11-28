import { z } from 'zod';
import { canSubscribeToEvent, readEventCatalog } from '../account-events.js';
import { ProfileError } from '../profile-store.js';
import type { ToolContext } from './common.js';

export function registerEventTools({ profiles, profileId, register }: ToolContext): void {
  register('marketplace_event_types_list', 'List subscribable event names grouped by permission. Filter by prefix, e.g. service.milestone.', {
    prefix: z.string().min(1).max(100).optional(),
    includeUnavailable: z.boolean().optional(),
  }, async (args, signal) => {
    const profile = profiles.getProfile(profileId);
    const catalog = await readEventCatalog(profile.origin, signal);
    const available: Record<string, string[]> = {};
    const unavailable: Record<string, string[]> = {};
    for (const entry of catalog) {
      if (typeof args.prefix === 'string' && !entry.type.startsWith(args.prefix)) continue;
      const allowed = canSubscribeToEvent(entry, profile);
      if (!allowed && !args.includeUnavailable) continue;
      const group = allowed ? available : unavailable;
      const permission = entry.scope ?? (entry.controllerOnly ? 'controller-session' : 'public');
      (group[permission] ??= []).push(entry.type);
    }
    return args.includeUnavailable ? { available, unavailable } : { available };
  }, { readOnly: true });

  register('marketplace_event_subscription_get', 'Read the saved event selection.', {}, async () => {
    return { types: profiles.readSavedEventTypes(profiles.getProfile(profileId)) };
  }, { readOnly: true });

  register('marketplace_event_subscription_set', 'Replace the saved wake-event selection. An empty list pauses delivery.', {
    types: z.array(z.string().min(1).max(128)).max(256),
  }, async (args, signal) => {
    const profile = profiles.getProfile(profileId);
    const types = [...new Set(args.types as string[])].sort();
    if (types.length) {
      const catalog = await readEventCatalog(profile.origin, signal);
      const allowed = new Set(catalog.filter(entry => canSubscribeToEvent(entry, profile)).map(entry => entry.type));
      if (types.some(type => !allowed.has(type))) {
        throw new ProfileError('EVENT_SUBSCRIPTION', 'Select available event types from marketplace_event_types_list.');
      }
    }
    profiles.writeSavedEventTypes(profile, types);
    return { types };
  }, undefined, true);
}
