/** HTTPS ports and credentials do not carry over to SSH. */
export function suggestSshUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.pathname === '/') return ''
    const path = url.pathname.replace(/^\/+/, '')
    if (url.hostname === 'dev.azure.com') {
      const match = path.match(/^([^/]+)\/([^/]+)\/_git\/(.+)$/)
      if (match) return `git@ssh.dev.azure.com:v3/${match[1]}/${match[2]}/${match[3]}`
    }
    return `git@${url.hostname}:${path}`
  } catch {
    return ''
  }
}

export function redactRemoteCredentials(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return 'HTTPS remote'
  }
}
