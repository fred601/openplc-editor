import { randomBytes, timingSafeEqual } from 'crypto'

const tokenBytes = new TextEncoder()

const generateBearerToken = (): string => randomBytes(32).toString('hex')

const authorizationHeaderMatches = (header: string | undefined, token: string): boolean => {
  if (!header || !token) return false
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (!match?.[1]) return false
  const provided = tokenBytes.encode(match[1])
  const expected = tokenBytes.encode(token)
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

export { authorizationHeaderMatches, generateBearerToken }
