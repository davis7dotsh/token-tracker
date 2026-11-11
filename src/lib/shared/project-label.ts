export const projectParts = (value: string) =>
  value
    .replace(/^local:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .split(/[\\/]/)
    .filter(Boolean);

export const projectLabel = (value: string) => projectParts(value).slice(-2).join('/') || value;
