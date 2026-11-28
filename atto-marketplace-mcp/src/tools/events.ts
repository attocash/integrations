import { z } from 'zod';
import { canSubscribeToEvent, readEventCatalog } from '../account-events.js';
import { ProfileError } from '../profile-store.js';
import type { ToolContext } from './common.js';

export function registerEventTools({ profiles, profileId, register }: ToolContext): void {
  register('marketplace_event_types_list', 'List public and account event types, their read permissions, and which the current profile can subscribe to.', {}, async (_, signal) => {
    const profile = profiles.getProfile(profileId);
    const catalog = await readEventCatalog(profile.origin, signal);
    return { types: catalog.map(entry => ({ ...entry, available: canSubscribeToEvent(entry, profile) })) };
  }, { readOnly: true });

  register('marketplace_event_subscription_get', 'Read the event types selected for this profile’s local listener in saved mode.', {}, async () => {
    return { types: profiles.readSavedEventTypes(profiles.getProfile(profileId)) };
  }, { readOnly: true });

  register('marketplace_event_subscription_set', 'Choose exactly which events wake this profile’s operator-configured listener when it runs with --types saved. Pass an empty array to pause delivery.', {
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
