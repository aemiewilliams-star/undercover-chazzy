const REVISION = /^[a-f0-9]{40}$/;

export function immutableCollectorSourceUrl(raw: string | undefined, revision: string | undefined): URL | null {
  if (!raw || !revision || !REVISION.test(revision)) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.includes(revision)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
