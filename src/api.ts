import type { KaraokeApi, Song } from './types'

const unavailable = async (): Promise<never> => {
  throw new Error('The secure desktop bridge did not load. Restart Karaoke Studio.')
}

const unavailableApi: KaraokeApi = {
  getLibrary: unavailable,
  importSongs: unavailable,
  removeSong: unavailable,
  processSong: unavailable,
  retranscribeSong: unavailable,
  retryDeliverable: unavailable,
  getPlaylists: unavailable,
  createPlaylist: unavailable,
  renamePlaylist: unavailable,
  deletePlaylist: unavailable,
  addSongToPlaylist: unavailable,
  removePlaylistEntry: unavailable,
  archiveQueueEntry: unavailable,
  clearPlaylist: unavailable,
  selectPlaylist: unavailable,
  setPlaylistCursor: unavailable,
  revealFile: unavailable,
  openDiagnostics: unavailable,
  reportRendererError: unavailable,
  updateAutomationStatus: () => undefined,
  onProcessUpdate: () => () => undefined,
  onDesktopControl: () => () => undefined,
}

export const karaokeApi: KaraokeApi = window.karaoke ?? unavailableApi
export type { Song }
