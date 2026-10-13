/** Session links opened by the optional desktop companion. */
export function linkedSessionId(search: string): string | null {
  const id = new URLSearchParams(search).get("session");
  return id && (/^ses_[a-zA-Z0-9_-]+$/.test(id)
    || /^codex:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) ? id : null;
}
