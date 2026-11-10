import type { UsageEvent } from '../../shared/domain';

type MutableEvent = { -readonly [K in keyof UsageEvent]: UsageEvent[K] };

// Only keys from this decode, bounded even for histories of one-off sessions.
// The representative is already retained by the page. It is never used as a
// source of metadata: only strings that compare equal may share its storage.
export const makePageStrings = () => {
  const sessions = new Map<string, UsageEvent>();
  return (event: MutableEvent) => {
    if (event.sessionId.length > 2048) return event;
    const known = sessions.get(event.sessionId);
    if (!known) {
      if (sessions.size < 1024) sessions.set(event.sessionId, event);
      return event;
    }
    // A fresh validated record, not yet exposed to a caller. Avoid setting
    // absent optional fields: presence is part of the decoded shape.
    event.sessionId = known.sessionId;
    if (event.model === known.model) event.model = known.model;
    if (event.project === known.project) event.project = known.project;
    if (event.repository === known.repository) event.repository = known.repository;
    if (event.deviceId !== undefined && event.deviceId === known.deviceId) event.deviceId = known.deviceId;
    if (event.rawModel !== undefined && event.rawModel === known.rawModel) event.rawModel = known.rawModel;
    if (event.sessionTitle !== undefined && event.sessionTitle === known.sessionTitle)
      event.sessionTitle = known.sessionTitle;
    if (event.projectName !== undefined && event.projectName === known.projectName)
      event.projectName = known.projectName;
    if (event.t3ThreadId !== undefined && event.t3ThreadId === known.t3ThreadId) event.t3ThreadId = known.t3ThreadId;
    if (event.t3ThreadUrl !== undefined && event.t3ThreadUrl === known.t3ThreadUrl)
      event.t3ThreadUrl = known.t3ThreadUrl;
    return event;
  };
};
