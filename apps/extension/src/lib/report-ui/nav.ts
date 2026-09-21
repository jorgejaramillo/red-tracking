export type Route = { name: 'home' } | { name: 'session'; id: string } | { name: 'study' };

export function currentRoute(): Route {
  const p = new URLSearchParams(location.search);
  const s = p.get('session');
  if (s) return { name: 'session', id: s };
  if (p.get('view') === 'study') return { name: 'study' };
  return { name: 'home' };
}

export function go(route: Route): void {
  const url = new URL(location.href);
  url.search = '';
  if (route.name === 'session') url.searchParams.set('session', route.id);
  if (route.name === 'study') url.searchParams.set('view', 'study');
  history.pushState(null, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDate(t: number): string {
  return new Date(t).toLocaleString();
}
