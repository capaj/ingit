import { expect, test } from 'bun:test'
import { redactRemoteCredentials, suggestSshUrl } from './ssh-remote'

test('suggests SSH addresses for GitHub and nested self-hosted repositories', () => {
  expect(suggestSshUrl('https://github.com/capaj/git-remote-sshify.git')).toBe('git@github.com:capaj/git-remote-sshify.git')
  expect(suggestSshUrl('https://git.example.org/group/sub/repo')).toBe('git@git.example.org:group/sub/repo')
  expect(suggestSshUrl('https://dev.azure.com/org/project/_git/repo')).toBe('git@ssh.dev.azure.com:v3/org/project/repo')
})

test('does not copy HTTPS credentials, query parameters or ports to SSH', () => {
  const url = 'https://user:secret@git.example.org:8443/team/repo.git?token=secret#fragment'
  expect(suggestSshUrl(url)).toBe('git@git.example.org:team/repo.git')
  expect(redactRemoteCredentials(url)).toBe('https://git.example.org:8443/team/repo.git')
  expect(suggestSshUrl('git@github.com:owner/repo.git')).toBe('')
  expect(suggestSshUrl('https://github.com/')).toBe('')
})
