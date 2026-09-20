export const TRUSTED_RENDERER_ORIGIN = 'karaoke://app'

interface MediaPermissionDetails {
  isMainFrame: boolean
  requestingUrl?: string
  securityOrigin?: string
  embeddingOrigin?: string
  mediaTypes?: Array<'audio' | 'video'>
  mediaType?: 'audio' | 'video' | 'unknown'
}

export function isTrustedRendererLocation(value: string | undefined) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'karaoke:'
      && url.hostname === 'app'
      && !url.port
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

export function shouldAllowMediaPermissionRequest(
  permission: string,
  details: MediaPermissionDetails,
  requestingWebContentsId: number,
  mainWebContentsId: number | undefined,
) {
  return permission === 'media'
    && requestingWebContentsId === mainWebContentsId
    && details.isMainFrame
    && isTrustedRendererLocation(details.requestingUrl)
    && isTrustedRendererLocation(details.securityOrigin)
    && details.mediaTypes?.length === 1
    && details.mediaTypes[0] === 'audio'
}

export function shouldAllowMediaPermissionCheck(
  permission: string,
  requestingOrigin: string,
  details: MediaPermissionDetails,
  requestingWebContentsId: number | undefined,
  mainWebContentsId: number | undefined,
) {
  return permission === 'media'
    && requestingWebContentsId === mainWebContentsId
    && details.isMainFrame
    && details.mediaType === 'audio'
    && isTrustedRendererLocation(requestingOrigin)
    && isTrustedRendererLocation(details.securityOrigin)
    && (!details.requestingUrl || isTrustedRendererLocation(details.requestingUrl))
    && !details.embeddingOrigin
}
