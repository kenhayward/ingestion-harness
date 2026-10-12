/** Short publish time for lists and previews, e.g. "12 Oct, 08:31". */
export const shortWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
