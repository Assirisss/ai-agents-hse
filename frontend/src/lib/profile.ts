/** Only two local workspaces are exposed by the demo switch; this is not authentication. */
export function workspaceProfile(): 'default' | 'demo' {
  return new URLSearchParams(window.location.search).get('financeProfile') === 'demo' ? 'demo' : 'default'
}

export function switchWorkspaceProfile(profile: 'default' | 'demo') {
  const url = new URL(window.location.href)
  url.searchParams.set('financeProfile', profile)
  // A full navigation aborts old requests and clears component state before changing the profile.
  window.location.assign(url.href)
}
