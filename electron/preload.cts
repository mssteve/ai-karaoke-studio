import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopControl,
  KaraokeApi,
  PlaybackAutomationStatus,
  ProcessUpdate,
} from './types.js'

const api: KaraokeApi = {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  importSongs: () => ipcRenderer.invoke('library:import'),
  removeSong: (id) => ipcRenderer.invoke('library:remove', id),
  processSong: (id) => ipcRenderer.invoke('ai:process', id),
  retranscribeSong: (id) => ipcRenderer.invoke('ai:retranscribe', id),
  updateLyrics: (request) => ipcRenderer.invoke('lyrics:update', request),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (request) => ipcRenderer.invoke('settings:set', request),
  retryDeliverable: (request) => ipcRenderer.invoke('ai:retry-deliverable', request),
  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  createPlaylist: (request) => ipcRenderer.invoke('playlists:create', request),
  renamePlaylist: (request) => ipcRenderer.invoke('playlists:rename', request),
  deletePlaylist: (request) => ipcRenderer.invoke('playlists:delete', request),
  addSongToPlaylist: (request) => ipcRenderer.invoke('playlists:add-song', request),
  removePlaylistEntry: (request) => ipcRenderer.invoke('playlists:remove-entry', request),
  archiveQueueEntry: (request) => ipcRenderer.invoke('playlists:archive-queue-entry', request),
  clearPlaylist: (request) => ipcRenderer.invoke('playlists:clear', request),
  selectPlaylist: (request) => ipcRenderer.invoke('playlists:select', request),
  setPlaylistCursor: (request) => ipcRenderer.invoke('playlists:set-cursor', request),
  revealFile: (path) => ipcRenderer.invoke('file:reveal', path),
  openDiagnostics: () => ipcRenderer.invoke('diagnostics:open'),
  reportRendererError: (message, detail) => ipcRenderer.invoke('diagnostics:renderer-error', message, detail),
  updateAutomationStatus: (status: PlaybackAutomationStatus) => ipcRenderer.send('automation:renderer-status', status),
  onProcessUpdate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, update: ProcessUpdate) => callback(update)
    ipcRenderer.on('ai:progress', listener)
    return () => ipcRenderer.removeListener('ai:progress', listener)
  },
  onDesktopControl: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: DesktopControl) => callback(command)
    ipcRenderer.on('automation:control', listener)
    return () => ipcRenderer.removeListener('automation:control', listener)
  },
}

contextBridge.exposeInMainWorld('karaoke', api)
