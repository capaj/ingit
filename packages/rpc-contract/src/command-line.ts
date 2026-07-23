/**
 * Split a command line into an executable and arguments without invoking a
 * shell. Single quotes, double quotes, and escaped whitespace/quotes are
 * supported; shell operators are passed through as ordinary arguments.
 */
export function parseCommandLine(command: string): string[] | null {
  const args: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: "'" | '"' | null = null

  const flush = () => {
    if (!tokenStarted) return
    args.push(token)
    token = ''
    tokenStarted = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!

    if (quote === "'") {
      if (character === "'") {
        quote = null
      } else {
        token += character
      }
      tokenStarted = true
      continue
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null
      } else if (character === '\\') {
        const next = command[index + 1]
        if (next === '"' || next === '\\') {
          token += next
          index += 1
        } else {
          token += character
        }
      } else {
        token += character
      }
      tokenStarted = true
      continue
    }

    if (/\s/.test(character)) {
      flush()
      continue
    }

    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
      continue
    }

    if (character === '\\') {
      const next = command[index + 1]
      if (next !== undefined && (/\s/.test(next) || next === "'" || next === '"' || next === '\\')) {
        token += next
        tokenStarted = true
        index += 1
        continue
      }
    }

    token += character
    tokenStarted = true
  }

  if (quote !== null) return null
  flush()
  return args.length > 0 ? args : null
}
