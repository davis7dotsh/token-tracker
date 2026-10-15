const minute = 60_000;

export const relativeTime = (value: string, now = Date.now()) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(value)) / minute));
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
};
