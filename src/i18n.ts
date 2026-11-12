import type {
  AppSettings,
  LyricRematchStatus,
  LyricTextSource,
  Playlist,
  RecognitionLanguageMode,
  UiLocale,
} from './types'

export const defaultAppSettings: AppSettings = {
  schemaVersion: 1,
  uiLocale: 'en',
  recognitionLanguageMode: 'auto',
  recognitionLanguageCode: 'en',
}

export const manualLyricsProtectedMessage = 'Manual lyrics are protected from AI text replacement.'
export const lyricsBusyMessage = 'Lyrics are busy with local processing.'
export const lyricRevisionConflictMessage = 'Lyric revision conflict.'

export const stableRendererErrors = [
  manualLyricsProtectedMessage,
  lyricsBusyMessage,
  lyricRevisionConflictMessage,
  'Edited lyrics are empty.',
  'Edited lyrics contain no usable lines.',
  'LRC timestamps are incomplete or invalid.',
  'Edited lyrics cannot fit a 40ms timeline.',
  'Unsupported recognition language.',
  'Unsupported interface language.',
] as const

export interface RecognitionLanguage {
  code: string
  en: string
  fr: string
}

/** Whisper multilingual short codes supported by the local timestamped model. */
export const recognitionLanguages: readonly RecognitionLanguage[] = [
  { code: 'en', en: 'English', fr: 'anglais' },
  { code: 'zh', en: 'Chinese', fr: 'chinois' },
  { code: 'de', en: 'German', fr: 'allemand' },
  { code: 'es', en: 'Spanish', fr: 'espagnol' },
  { code: 'ru', en: 'Russian', fr: 'russe' },
  { code: 'ko', en: 'Korean', fr: 'coréen' },
  { code: 'fr', en: 'French', fr: 'français' },
  { code: 'ja', en: 'Japanese', fr: 'japonais' },
  { code: 'pt', en: 'Portuguese', fr: 'portugais' },
  { code: 'tr', en: 'Turkish', fr: 'turc' },
  { code: 'pl', en: 'Polish', fr: 'polonais' },
  { code: 'ca', en: 'Catalan', fr: 'catalan' },
  { code: 'nl', en: 'Dutch', fr: 'néerlandais' },
  { code: 'ar', en: 'Arabic', fr: 'arabe' },
  { code: 'sv', en: 'Swedish', fr: 'suédois' },
  { code: 'it', en: 'Italian', fr: 'italien' },
  { code: 'id', en: 'Indonesian', fr: 'indonésien' },
  { code: 'hi', en: 'Hindi', fr: 'hindi' },
  { code: 'fi', en: 'Finnish', fr: 'finnois' },
  { code: 'vi', en: 'Vietnamese', fr: 'vietnamien' },
  { code: 'he', en: 'Hebrew', fr: 'hébreu' },
  { code: 'uk', en: 'Ukrainian', fr: 'ukrainien' },
  { code: 'el', en: 'Greek', fr: 'grec' },
  { code: 'ms', en: 'Malay', fr: 'malais' },
  { code: 'cs', en: 'Czech', fr: 'tchèque' },
  { code: 'ro', en: 'Romanian', fr: 'roumain' },
  { code: 'da', en: 'Danish', fr: 'danois' },
  { code: 'hu', en: 'Hungarian', fr: 'hongrois' },
  { code: 'ta', en: 'Tamil', fr: 'tamoul' },
  { code: 'no', en: 'Norwegian', fr: 'norvégien' },
  { code: 'th', en: 'Thai', fr: 'thaï' },
  { code: 'ur', en: 'Urdu', fr: 'ourdou' },
  { code: 'hr', en: 'Croatian', fr: 'croate' },
  { code: 'bg', en: 'Bulgarian', fr: 'bulgare' },
  { code: 'lt', en: 'Lithuanian', fr: 'lituanien' },
  { code: 'la', en: 'Latin', fr: 'latin' },
  { code: 'mi', en: 'Maori', fr: 'maori' },
  { code: 'ml', en: 'Malayalam', fr: 'malayalam' },
  { code: 'cy', en: 'Welsh', fr: 'gallois' },
  { code: 'sk', en: 'Slovak', fr: 'slovaque' },
  { code: 'te', en: 'Telugu', fr: 'télougou' },
  { code: 'fa', en: 'Persian', fr: 'persan' },
  { code: 'lv', en: 'Latvian', fr: 'letton' },
  { code: 'bn', en: 'Bengali', fr: 'bengali' },
  { code: 'sr', en: 'Serbian', fr: 'serbe' },
  { code: 'az', en: 'Azerbaijani', fr: 'azéri' },
  { code: 'sl', en: 'Slovenian', fr: 'slovène' },
  { code: 'kn', en: 'Kannada', fr: 'kannada' },
  { code: 'et', en: 'Estonian', fr: 'estonien' },
  { code: 'mk', en: 'Macedonian', fr: 'macédonien' },
  { code: 'br', en: 'Breton', fr: 'breton' },
  { code: 'eu', en: 'Basque', fr: 'basque' },
  { code: 'is', en: 'Icelandic', fr: 'islandais' },
  { code: 'hy', en: 'Armenian', fr: 'arménien' },
  { code: 'ne', en: 'Nepali', fr: 'népalais' },
  { code: 'mn', en: 'Mongolian', fr: 'mongol' },
  { code: 'bs', en: 'Bosnian', fr: 'bosniaque' },
  { code: 'kk', en: 'Kazakh', fr: 'kazakh' },
  { code: 'sq', en: 'Albanian', fr: 'albanais' },
  { code: 'sw', en: 'Swahili', fr: 'swahili' },
  { code: 'gl', en: 'Galician', fr: 'galicien' },
  { code: 'mr', en: 'Marathi', fr: 'marathi' },
  { code: 'pa', en: 'Punjabi', fr: 'pendjabi' },
  { code: 'si', en: 'Sinhala', fr: 'cingalais' },
  { code: 'km', en: 'Khmer', fr: 'khmer' },
  { code: 'sn', en: 'Shona', fr: 'shona' },
  { code: 'yo', en: 'Yoruba', fr: 'yoruba' },
  { code: 'so', en: 'Somali', fr: 'somali' },
  { code: 'af', en: 'Afrikaans', fr: 'afrikaans' },
  { code: 'oc', en: 'Occitan', fr: 'occitan' },
  { code: 'ka', en: 'Georgian', fr: 'géorgien' },
  { code: 'be', en: 'Belarusian', fr: 'biélorusse' },
  { code: 'tg', en: 'Tajik', fr: 'tadjik' },
  { code: 'sd', en: 'Sindhi', fr: 'sindhi' },
  { code: 'gu', en: 'Gujarati', fr: 'goudjarati' },
  { code: 'am', en: 'Amharic', fr: 'amharique' },
  { code: 'yi', en: 'Yiddish', fr: 'yiddish' },
  { code: 'lo', en: 'Lao', fr: 'lao' },
  { code: 'uz', en: 'Uzbek', fr: 'ouzbek' },
  { code: 'fo', en: 'Faroese', fr: 'féroïen' },
  { code: 'ht', en: 'Haitian Creole', fr: 'créole haïtien' },
  { code: 'ps', en: 'Pashto', fr: 'pachto' },
  { code: 'tk', en: 'Turkmen', fr: 'turkmène' },
  { code: 'nn', en: 'Nynorsk', fr: 'nynorsk' },
  { code: 'mt', en: 'Maltese', fr: 'maltais' },
  { code: 'sa', en: 'Sanskrit', fr: 'sanskrit' },
  { code: 'lb', en: 'Luxembourgish', fr: 'luxembourgeois' },
  { code: 'my', en: 'Myanmar', fr: 'birman' },
  { code: 'bo', en: 'Tibetan', fr: 'tibétain' },
  { code: 'tl', en: 'Tagalog', fr: 'tagalog' },
  { code: 'mg', en: 'Malagasy', fr: 'malgache' },
  { code: 'as', en: 'Assamese', fr: 'assamais' },
  { code: 'tt', en: 'Tatar', fr: 'tatar' },
  { code: 'haw', en: 'Hawaiian', fr: 'hawaïen' },
  { code: 'ln', en: 'Lingala', fr: 'lingala' },
  { code: 'ha', en: 'Hausa', fr: 'haoussa' },
  { code: 'ba', en: 'Bashkir', fr: 'bachkir' },
  { code: 'jw', en: 'Javanese', fr: 'javanais' },
  { code: 'su', en: 'Sundanese', fr: 'soundanais' },
]

const recognitionLanguageCodes = new Set(recognitionLanguages.map((language) => language.code))

export function isKnownRecognitionLanguage(code: string) {
  return recognitionLanguageCodes.has(code)
}

export function recognitionLanguageLabel(language: RecognitionLanguage, locale: UiLocale) {
  const name = locale === 'fr' ? language.fr : language.en
  return `${name} (${language.code})`
}

export function recognitionLanguageOptions(locale: UiLocale, currentCode: string) {
  const known = recognitionLanguages.some((language) => language.code === currentCode)
  const extra = currentCode && !known
    ? [{ code: currentCode, en: currentCode, fr: currentCode, unsupported: true as const }]
    : []
  const labeled = [...recognitionLanguages.map((language) => ({ ...language, unsupported: false as const })), ...extra]
  const pinned = ['en', 'fr']
    .map((code) => labeled.find((language) => language.code === code))
    .filter((language): language is (typeof labeled)[number] => Boolean(language))
  const rest = labeled
    .filter((language) => !pinned.some((item) => item.code === language.code))
    .sort((left, right) => recognitionLanguageLabel(left, locale).localeCompare(
      recognitionLanguageLabel(right, locale),
      locale === 'fr' ? 'fr' : 'en',
    ))
  return [...pinned, ...rest].map((language) => ({
    code: language.code,
    unsupported: language.unsupported,
    label: language.unsupported
      ? `${language.code} (${locale === 'fr' ? 'non pris en charge' : 'unsupported'})`
      : recognitionLanguageLabel(language, locale),
  }))
}

export function normalizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') throw new Error('Unsupported interface language.')
  const record = value as Partial<AppSettings>
  if (record.schemaVersion !== 1) throw new Error('Unsupported interface language.')
  if (record.uiLocale !== 'en' && record.uiLocale !== 'fr') throw new Error('Unsupported interface language.')
  if (record.recognitionLanguageMode !== 'auto' && record.recognitionLanguageMode !== 'manual') {
    throw new Error('Unsupported recognition language.')
  }
  if (typeof record.recognitionLanguageCode !== 'string' || !/^[a-z]{2,3}$/.test(record.recognitionLanguageCode)) {
    throw new Error('Unsupported recognition language.')
  }
  return {
    schemaVersion: 1,
    uiLocale: record.uiLocale,
    recognitionLanguageMode: record.recognitionLanguageMode,
    recognitionLanguageCode: record.recognitionLanguageCode,
  }
}

export function editorTextFromSong(song: { lyricEditorText?: string; lyrics?: Array<{ text: string }> }) {
  return song.lyricEditorText ?? (song.lyrics ?? []).map((line) => line.text).join('\n')
}

export function replaceEditorSelection(text: string, start: number, end: number, inserted: string) {
  const rawOffset = (offset: number) => {
    let index = 0
    for (let logical = 0; logical < offset && index < text.length; logical += 1) {
      if (text[index] === '\r' && text[index + 1] === '\n') index += 1
      index += 1
    }
    return index
  }
  return text.slice(0, rawOffset(start)) + inserted + text.slice(rawOffset(end))
}

export function editorTextFromInput(previous: string, input: string) {
  // Textareas expose LF offsets even when the saved text uses CRLF.
  const normalized = previous.replace(/\r\n?/g, '\n')
  let start = 0
  while (start < normalized.length && start < input.length && normalized[start] === input[start]) start += 1
  let end = normalized.length
  let inputEnd = input.length
  while (end > start && inputEnd > start && normalized[end - 1] === input[inputEnd - 1]) {
    end -= 1
    inputEnd -= 1
  }
  const lineBreak = previous.match(/\r\n|\r|\n/)?.[0] ?? '\n'
  return replaceEditorSelection(previous, start, end, input.slice(start, inputEnd).replace(/\n/g, lineBreak))
}

export function hasUsableLyricLines(text: string) {
  return text.split(/\r?\n/).some((line) => line.trim().length > 0)
}

export interface LyricsEditorSongSnapshot {
  songId: string
  songTitle: string
  text: string
  revision: number
}

export type LyricsEditorSaveState = 'idle' | 'saving' | 'saved' | 'failed'

export interface LyricsEditorDraft {
  songId: string
  songTitle: string
  text: string
  baselineText: string
  expectedRevision: number
  saving: boolean
  saveId: number
  discardPrompt: boolean
  conflict: boolean
  closeRequested: boolean
  pendingSwitch?: LyricsEditorSongSnapshot
  saveState: LyricsEditorSaveState
  saveDetail?: string
  rematch?: 'queued' | 'skipped'
}

export type LyricsEditorAction =
  | { type: 'open'; song: LyricsEditorSongSnapshot }
  | { type: 'edit'; text: string }
  | { type: 'request-close' }
  | { type: 'confirm-discard' }
  | { type: 'keep-editing' }
  | { type: 'song-changed'; song?: LyricsEditorSongSnapshot }
  | { type: 'save-start'; saveId: number }
  | {
    type: 'save-result'
    saveId: number
    songId: string
    ok: boolean
    submittedText: string
    revision?: number
    rematch?: 'queued' | 'skipped'
    conflict?: boolean
    detail?: string
  }
  | { type: 'reload-saved'; text: string; revision: number }

function draftFromSong(song: LyricsEditorSongSnapshot, saveId = 0): LyricsEditorDraft {
  return {
    songId: song.songId,
    songTitle: song.songTitle,
    text: song.text,
    baselineText: song.text,
    expectedRevision: song.revision,
    saving: false,
    saveId,
    discardPrompt: false,
    conflict: false,
    closeRequested: false,
    saveState: 'idle',
  }
}

function isDirty(draft: LyricsEditorDraft) {
  return draft.text !== draft.baselineText
}

export function reduceLyricsEditor(
  draft: LyricsEditorDraft | null,
  action: LyricsEditorAction,
): LyricsEditorDraft | null {
  switch (action.type) {
    case 'open':
      if (!draft) return draftFromSong(action.song)
      if (draft.songId === action.song.songId) return draft.saving ? draft : { ...draft, discardPrompt: false }
      if (draft.saving || isDirty(draft)) return { ...draft, pendingSwitch: action.song, discardPrompt: true }
      return draftFromSong(action.song, draft.saveId)
    case 'edit':
      if (!draft || draft.saving || action.text === draft.text) return draft
      return {
        ...draft,
        text: action.text,
        conflict: false,
        saveState: 'idle',
        saveDetail: undefined,
        rematch: undefined,
      }
    case 'request-close':
      if (!draft) return null
      if (draft.saving) return { ...draft, closeRequested: true }
      if (isDirty(draft) || draft.pendingSwitch) return { ...draft, discardPrompt: true }
      return null
    case 'confirm-discard':
      if (!draft || draft.saving) return draft
      if (draft.pendingSwitch) return draftFromSong(draft.pendingSwitch, draft.saveId)
      return null
    case 'keep-editing':
      if (!draft) return null
      return { ...draft, discardPrompt: false, pendingSwitch: undefined, closeRequested: false }
    case 'song-changed': {
      if (!draft) return null
      if (!action.song) {
        if (draft.saving || isDirty(draft)) return { ...draft, pendingSwitch: undefined, discardPrompt: !draft.saving }
        return null
      }
      if (action.song.songId === draft.songId) {
        if (draft.saving || isDirty(draft) || draft.text !== action.song.text) {
          return draft.songTitle === action.song.songTitle ? draft : { ...draft, songTitle: action.song.songTitle }
        }
        if (draft.expectedRevision === action.song.revision && draft.songTitle === action.song.songTitle) return draft
        return {
          ...draft,
          songTitle: action.song.songTitle,
          text: action.song.text,
          baselineText: action.song.text,
          expectedRevision: action.song.revision,
        }
      }
      if (draft.saving) return { ...draft, pendingSwitch: action.song }
      if (isDirty(draft)) return { ...draft, pendingSwitch: action.song, discardPrompt: true }
      return draftFromSong(action.song, draft.saveId)
    }
    case 'save-start':
      if (!draft || draft.saving) return draft
      return {
        ...draft,
        saving: true,
        saveId: action.saveId,
        conflict: false,
        saveState: 'saving',
        saveDetail: undefined,
        discardPrompt: false,
      }
    case 'save-result': {
      if (!draft || action.saveId !== draft.saveId || action.songId !== draft.songId) return draft
      if (!action.ok) {
        return {
          ...draft,
          saving: false,
          conflict: Boolean(action.conflict),
          closeRequested: false,
          saveState: 'failed',
          saveDetail: action.detail,
          discardPrompt: Boolean(draft.pendingSwitch),
        }
      }
      const textMatches = draft.text === action.submittedText
      if (draft.closeRequested && textMatches) return null
      if (draft.pendingSwitch && textMatches) return draftFromSong(draft.pendingSwitch, draft.saveId)
      return {
        ...draft,
        saving: false,
        text: draft.text,
        baselineText: textMatches ? action.submittedText : draft.baselineText,
        expectedRevision: textMatches && action.revision !== undefined ? action.revision : draft.expectedRevision,
        saveState: 'saved',
        rematch: action.rematch,
        saveDetail: undefined,
        conflict: false,
        closeRequested: false,
      }
    }
    case 'reload-saved':
      if (!draft || draft.saving) return draft
      return {
        ...draft,
        text: action.text,
        baselineText: action.text,
        expectedRevision: action.revision,
        conflict: false,
        saveState: 'idle',
        saveDetail: undefined,
        discardPrompt: false,
        rematch: undefined,
      }
    default:
      return draft
  }
}

export function lyricsEditorStatusMessage(input: {
  draft: LyricsEditorDraft
  songId?: string
  songRevision?: number
  songRematchStatus?: LyricRematchStatus
  songRematchMessage?: string
  busy: boolean
}): string {
  const { draft } = input
  if (draft.discardPrompt) {
    return draft.pendingSwitch
      ? `The selected song changed. Discard unsaved edits for ${draft.songTitle}?`
      : 'Discard unsaved lyric edits?'
  }
  if (draft.saving || draft.saveState === 'saving') return 'Saving edited lyrics…'
  if (draft.conflict) return lyricRevisionConflictMessage
  if (draft.saveState === 'failed') return draft.saveDetail || 'Unable to update lyrics'
  if (!hasUsableLyricLines(draft.text)) {
    return draft.text.trim() ? 'Edited lyrics contain no usable lines.' : 'Edited lyrics are empty.'
  }
  const matchingSavedRevision = input.songId === draft.songId
    && input.songRevision === draft.expectedRevision
    && !isDirty(draft)
  if (matchingSavedRevision && (input.songRematchStatus === 'failed' || input.songRematchStatus === 'complete')) {
    return lyricsRematchMessage(input.songRematchStatus, input.songRematchMessage)!
  }
  if (draft.saveState === 'saved' && draft.rematch === 'queued') {
    return 'Lyrics saved. Timing rematch is queued and will not replace your text.'
  }
  if (draft.saveState === 'saved' && draft.rematch === 'skipped') {
    return 'Lyrics saved. Existing timing was kept.'
  }
  if (input.busy) return lyricsBusyMessage
  if (matchingSavedRevision && input.songRematchStatus && input.songRematchStatus !== 'none') {
    return lyricsRematchMessage(input.songRematchStatus, input.songRematchMessage)
      ?? 'Timing rematch is pending. Your edited text stays as saved.'
  }
  return 'Paste or edit the full lyrics. Saved timing stays as a reference and is rematched automatically. AI will not replace this text.'
}

export function lyricsRematchMessage(status?: LyricRematchStatus, detail?: string) {
  switch (status) {
    case 'pending':
      return 'Timing rematch is pending. Your edited text stays as saved.'
    case 'complete':
      return 'Timing rematch complete. Edited text was preserved.'
    case 'failed':
      return detail
        ? `Timing rematch failed. Your edited text and existing timing were kept: ${detail}`
        : 'Timing rematch failed. Your edited text and existing timing were kept.'
    case 'skipped':
      return 'Timing rematch skipped. Edited text was kept.'
    default:
      return undefined
  }
}

export function lyricsTextSourceLabel(source?: LyricTextSource) {
  return source === 'user' ? 'Edited' : 'AI'
}

export function playlistDisplayName(locale: UiLocale, playlist: Pick<Playlist, 'kind' | 'name'>) {
  if (playlist.kind === 'queue') return translate(locale, 'Queue')
  if (playlist.kind === 'history') return translate(locale, 'History')
  return playlist.name
}

export const frenchCopy: Record<string, string> = {
  'Private · On-device AI': 'Privé · IA sur l’appareil',
  Diagnostics: 'Diagnostics',
  'Open diagnostics folder': 'Ouvrir le dossier de diagnostics',
  'Unable to open diagnostics': 'Impossible d’ouvrir les diagnostics',
  'Main navigation': 'Navigation principale',
  Library: 'Bibliothèque',
  Playlists: 'Listes de lecture',
  'Runs locally': 'Fonctionne en local',
  'Your music never leaves this PC.': 'Votre musique ne quitte jamais ce PC.',
  'YOUR COLLECTION': 'VOTRE COLLECTION',
  'Song Library': 'Bibliothèque de chansons',
  'Add songs': 'Ajouter des chansons',
  'Adding…': 'Ajout…',
  'Search songs or artists': 'Rechercher des chansons ou des artistes',
  'FIFO playlists': 'Listes FIFO',
  'Loading your library': 'Chargement de votre bibliothèque',
  'Finding songs stored on this PC.': 'Recherche des chansons stockées sur ce PC.',
  'Bring your music to the stage': 'Amenez votre musique sur scène',
  'Import MP3 or MP4 files to create karaoke versions with local AI.': 'Importez des fichiers MP3 ou MP4 pour créer des versions karaoké avec l’IA locale.',
  'Choose songs': 'Choisir des chansons',
  'Song library': 'Bibliothèque de chansons',
  TRACK: 'TITRE',
  STATUS: 'STATUT',
  ADDED: 'AJOUTÉ',
  Queued: 'En file',
  'Karaoke ready': 'Karaoké prêt',
  'Needs attention': 'Attention requise',
  Original: 'Originale',
  'FIFO COLLECTIONS': 'COLLECTIONS FIFO',
  'Queue order is preserved exactly as added.': 'L’ordre de la file est conservé exactement comme ajouté.',
  'New playlist': 'Nouvelle liste',
  'Saved playlists': 'Listes enregistrées',
  'PLAYING IN ORDER': 'LECTURE DANS L’ORDRE',
  Playlist: 'Liste',
  Queue: 'File d’attente',
  History: 'Historique',
  Play: 'Lecture',
  Clear: 'Vider',
  Rename: 'Renommer',
  Delete: 'Supprimer',
  'No songs yet': 'Aucune chanson',
  'Songs move here after they finish playing from Queue.': 'Les chansons arrivent ici après avoir été lues depuis la file.',
  'Use a song’s plus menu in Library to add it here.': 'Utilisez le menu plus d’une chanson dans la bibliothèque pour l’ajouter ici.',
  'Missing song': 'Chanson manquante',
  Unavailable: 'Indisponible',
  Current: 'En cours',
  'NOW SELECTED': 'SÉLECTION ACTUELLE',
  'Audio version': 'Version audio',
  Enhanced: 'Améliorée',
  Vocal: 'Voix',
  Instrumental: 'Instrumentale',
  'Enhanced auto-balanced': 'Améliorée, équilibrée automatiquement',
  'Output was too quiet for reliable loudness measurement.': 'La sortie était trop faible pour une mesure fiable du volume.',
  'Mild noise reduction was applied; separation artifacts may remain.': 'Une légère réduction du bruit a été appliquée ; des artefacts de séparation peuvent rester.',
  'Refresh original-language lyrics': 'Actualiser les paroles dans la langue d’origine',
  'Create karaoke version': 'Créer la version karaoké',
  'Some components need attention': 'Certains éléments demandent attention',
  'Local AI is working': 'L’IA locale travaille',
  'Reuse the existing vocal stem to detect the original language and correct timed lyrics.': 'Réutilise la piste vocale existante pour détecter la langue d’origine et corriger les paroles synchronisées.',
  'Create four audio versions and synchronized lyrics.': 'Crée quatre versions audio et des paroles synchronisées.',
  'Waiting to start': 'En attente de démarrage',
  'Processing needs attention': 'Le traitement demande attention',
  Finalizing: 'Finalisation',
  'Overall karaoke processing progress': 'Progression globale du traitement karaoké',
  'Karaoke deliverables': 'Éléments karaoké',
  details: 'détails',
  'Processing issues': 'Problèmes de traitement',
  Blocked: 'Bloqué',
  Failed: 'Échec',
  'Try again': 'Réessayer',
  'Extract with local AI': 'Extraire avec l’IA locale',
  'Refresh lyrics & language': 'Actualiser les paroles et la langue',
  'Retry lyrics refresh': 'Réessayer l’actualisation des paroles',
  SYNCED: 'SYNCHRO',
  Lyrics: 'Paroles',
  Timed: 'Synchronisées',
  Waiting: 'En attente',
  Edit: 'Modifier',
  'Edit the saved lyrics for this song': 'Modifier les paroles enregistrées de cette chanson',
  'Timed lyrics will appear here after local AI processing.': 'Les paroles synchronisées apparaîtront ici après le traitement par l’IA locale.',
  'Lyrics blocked': 'Paroles bloquées',
  'Lyrics failed': 'Échec des paroles',
  'Select or add a song to begin.': 'Sélectionnez ou ajoutez une chanson pour commencer.',
  'No song selected': 'Aucune chanson sélectionnée',
  'Add music to begin': 'Ajoutez de la musique pour commencer',
  'Previous song': 'Chanson précédente',
  Pause: 'Pause',
  'Next song': 'Chanson suivante',
  'Playback position': 'Position de lecture',
  'Mic off': 'Micro coupé',
  'Requesting mic…': 'Demande du micro…',
  'Mic live — monitor muted': 'Micro actif — retour coupé',
  'Mic live — no input detected': 'Micro actif — aucune entrée détectée',
  'Mic input detected': 'Entrée micro détectée',
  'Mic live': 'Micro actif',
  'Turn microphone monitor off': 'Couper le retour micro',
  'Cancel microphone request': 'Annuler la demande de micro',
  'Retry microphone monitor': 'Réessayer le retour micro',
  'Turn microphone monitor on': 'Activer le retour micro',
  'Permission denied — retry': 'Permission refusée — réessayer',
  'No microphone — retry': 'Aucun micro — réessayer',
  'Mic disconnected — retry': 'Micro déconnecté — réessayer',
  'Audio interrupted — retry': 'Audio interrompu — réessayer',
  'Mic unavailable — retry': 'Micro indisponible — réessayer',
  '0% (muted)': '0 % (coupé)',
  'Input detected': 'Entrée détectée',
  'Input waiting': 'Entrée en attente',
  'Default output · check Windows if silent': 'Sortie par défaut · vérifiez Windows si silence',
  'Clipping — lower Mic monitor level': 'Écrêtage — baissez le niveau du retour micro',
  'Output too hot — lower level': 'Sortie trop forte — baissez le niveau',
  'Check mic mute/input device': 'Vérifiez le mute ou l’entrée du micro',
  'Mic monitor level': 'Niveau du retour micro',
  'Audio controls': 'Commandes audio',
  'Audio settings': 'Réglages audio',
  'Song volume': 'Volume de la chanson',
  'Mute all audio': 'Couper tout le son',
  'Unmute all audio': 'Rétablir tout le son',
  'Microphone echo': 'Écho du micro',
  Echo: 'Écho',
  'Echo amount': 'Niveau de l’écho',
  'Echo affects repeats only; your direct voice is not delayed.': 'L’écho ne retarde que les répétitions, pas votre voix directe.',
  'High boost: use wired headphones; lower it if feedback or clipping starts.': 'Gain élevé : utilisez un casque filaire ; baissez-le si un larsen ou un écrêtage commence.',
  'Independent of song volume.': 'Indépendant du volume de la chanson.',
  Volume: 'Volume',
  'Add to playlist': 'Ajouter à une liste',
  'New playlist…': 'Nouvelle liste…',
  Close: 'Fermer',
  'Playlist name': 'Nom de la liste',
  'Create playlist': 'Créer la liste',
  Cancel: 'Annuler',
  'Clear playlist': 'Vider la liste',
  'Every entry will be removed. Your library songs will stay on this PC.': 'Toutes les entrées seront retirées. Les chansons de la bibliothèque restent sur ce PC.',
  'Rename playlist': 'Renommer la liste',
  'Cancel renaming playlist': 'Annuler le renommage de la liste',
  'Save name': 'Enregistrer le nom',
  'Cancel deleting playlist': 'Annuler la suppression de la liste',
  'Delete playlist': 'Supprimer la liste',
  'The playlist will be deleted. Its songs will remain in your library.': 'La liste sera supprimée. Ses chansons resteront dans la bibliothèque.',
  'Cancel clearing playlist': 'Annuler le vidage de la liste',
  Dismiss: 'Fermer',
  'Use wired headphones before monitoring to prevent feedback. Bluetooth latency is unsupported.': 'Utilisez un casque filaire avant le retour pour éviter le larsen. La latence Bluetooth n’est pas prise en charge.',
  'Wired headphones recommended. Monitor gain is independent of song volume and uses the system default output.': 'Casque filaire recommandé. Le gain du retour est indépendant du volume de la chanson et utilise la sortie système par défaut.',
  'Unable to load saved songs and playlists': 'Impossible de charger les chansons et listes enregistrées',
  'Automation could not select the requested song': 'L’automatisation n’a pas pu sélectionner la chanson demandée',
  'The playlist song no longer exists': 'La chanson de la liste n’existe plus',
  'Unable to select the playlist entry': 'Impossible de sélectionner l’entrée de la liste',
  'Unable to move the played song to History': 'Impossible de déplacer la chanson lue vers l’historique',
  'Unable to import songs': 'Impossible d’importer les chansons',
  'Unable to create the karaoke versions': 'Impossible de créer les versions karaoké',
  'Unable to refresh lyrics and language': 'Impossible d’actualiser les paroles et la langue',
  'Unable to open the playlist': 'Impossible d’ouvrir la liste',
  'Unable to create the playlist': 'Impossible de créer la liste',
  'Unable to remove the playlist entry': 'Impossible de retirer l’entrée de la liste',
  'Unable to clear the playlist': 'Impossible de vider la liste',
  'Unable to rename the playlist': 'Impossible de renommer la liste',
  'Unable to delete the playlist': 'Impossible de supprimer la liste',
  'Playlist deleted. Library songs were not removed.': 'Liste supprimée. Les chansons de la bibliothèque n’ont pas été retirées.',
  'Microphone access was denied. Check Windows Privacy & security > Microphone, then retry.': 'Accès au micro refusé. Vérifiez Confidentialité et sécurité Windows > Microphone, puis réessayez.',
  'No microphone is available. Connect one, then retry.': 'Aucun micro n’est disponible. Branchez-en un, puis réessayez.',
  'The microphone is unavailable or in use by another app.': 'Le micro est indisponible ou utilisé par une autre application.',
  'The microphone could not satisfy the requested audio settings.': 'Le micro n’a pas pu respecter les réglages audio demandés.',
  'Microphone monitoring could not start.': 'Le retour micro n’a pas pu démarrer.',
  'Microphone monitoring requires the secure Karaoke Studio app context.': 'Le retour micro exige le contexte sécurisé de Karaoke Studio.',
  'Audio monitoring was interrupted. Toggle the microphone to retry.': 'Le suivi audio a été interrompu. Basculez le micro pour réessayer.',
  'The microphone device changed. Toggle monitoring to reconnect safely.': 'Le périphérique micro a changé. Basculez le retour pour vous reconnecter.',
  'No audio track was returned.': 'Aucune piste audio n’a été renvoyée.',
  'Unable to load interface settings': 'Impossible de charger les réglages d’interface',
  'Unable to save interface settings': 'Impossible d’enregistrer les réglages d’interface',
  'Unable to update lyrics': 'Impossible de mettre à jour les paroles',
  'Unable to resume playback after seeking': 'Impossible de reprendre la lecture après le déplacement',
  'Unable to start playback': 'Impossible de démarrer la lecture',
  'Unable to continue playback': 'Impossible de poursuivre la lecture',
  'Unable to load this audio version': 'Impossible de charger cette version audio',
  'Unknown media error': 'Erreur multimédia inconnue',
  'The playlist no longer exists.': 'La liste de lecture n’existe plus.',
  'The playlist changed. Refresh and try again.': 'La liste a changé. Actualisez et réessayez.',
  'Playlist name cannot be empty.': 'Le nom de la liste ne peut pas être vide.',
  'Queue and History are reserved playlist names.': 'Queue et History sont des noms réservés aux listes système.',
  'A playlist with that name already exists.': 'Une liste portant ce nom existe déjà.',
  'System playlists cannot be renamed.': 'Les listes système ne peuvent pas être renommées.',
  'System playlists cannot be deleted.': 'Les listes système ne peuvent pas être supprimées.',
  'Songs cannot be added directly to History.': 'Les chansons ne peuvent pas être ajoutées directement à l’historique.',
  'The song no longer exists in the library.': 'La chanson n’existe plus dans la bibliothèque.',
  'Song was not found in the local library.': 'La chanson est introuvable dans la bibliothèque locale.',
  'The playlist entry no longer exists.': 'L’entrée de la liste n’existe plus.',
  'The queue entry no longer exists.': 'L’entrée de la file d’attente n’existe plus.',
  'Only Queue entries can be archived.': 'Seules les entrées de la file d’attente peuvent être archivées.',
  'Original audio': 'Audio original',
  'Source preparation': 'Préparation de la source',
  'Stem separation': 'Séparation des pistes',
  'Demucs separation': 'Séparation Demucs',
  'Vocal stem': 'Piste voix',
  'Drums stem': 'Piste batterie',
  'Drum stem': 'Piste batterie',
  'Bass stem': 'Piste basse',
  'Other stem': 'Autre piste',
  'Instrumental output': 'Sortie instrumentale',
  'Vocal output': 'Sortie voix',
  'Enhanced output': 'Sortie améliorée',
  'Lyrics model': 'Modèle de paroles',
  'Whisper model': 'Modèle Whisper',
  'Lyrics transcription': 'Transcription des paroles',
  'Whisper transcription': 'Transcription Whisper',
  'Timed lyrics': 'Paroles synchronisées',
  'Library save': 'Enregistrement de la bibliothèque',
  'Transcription audio preparation': 'Préparation audio de la transcription',
  Active: 'Actif',
  Complete: 'Terminé',
  'Requesting…': 'Demande…',
  'Working…': 'Travail…',
  'This component did not finish.': 'Cet élément ne s’est pas terminé.',
  'processing failed': 'échec du traitement',
  'a required component': 'un élément requis',
  'Mild instrumental noise cleanup applied': 'Nettoyage léger du bruit instrumental appliqué',
  'Validating original source': 'Validation de la source originale',
  'Original source is ready': 'La source originale est prête',
  'Preparing studio-quality separation audio': 'Préparation de l’audio de séparation en qualité studio',
  'Preparing separation and transcription audio': 'Préparation de l’audio de séparation et de transcription',
  'Source conversion outputs are validated': 'Les sorties de conversion de la source sont validées',
  'Source preparation outputs are validated': 'Les sorties de préparation de la source sont validées',
  'Validated existing artifact for reuse': 'Fichier existant validé pour réutilisation',
  'Loading the local Demucs model': 'Chargement du modèle Demucs local',
  'Demucs separation completed': 'Séparation Demucs terminée',
  'Mixing instrumental output': 'Mixage de la sortie instrumentale',
  'Instrumental output is validated': 'La sortie instrumentale est validée',
  'Improving vocal presence and clarity': 'Amélioration de la présence et de la clarté de la voix',
  'Vocal output is validated': 'La sortie voix est validée',
  'Mixing enhanced output': 'Mixage de la sortie améliorée',
  'Enhanced output is validated': 'La sortie améliorée est validée',
  'Measuring Vocal with EBU R128': 'Mesure de la voix avec EBU R128',
  'The premix was too quiet for finite EBU R128 normalization; no loudness boost was applied.': 'Le prémix était trop faible pour une normalisation EBU R128 finie ; aucune amplification n’a été appliquée.',
  'Preparing the existing vocal stem for Whisper': 'Préparation de la piste vocale existante pour Whisper',
  'Preparing the valid vocal output for Whisper': 'Préparation de la sortie voix validée pour Whisper',
  'Whisper-ready audio is validated': 'L’audio prêt pour Whisper est validé',
  'Loading the local Whisper model': 'Chargement du modèle Whisper local',
  'Whisper model is ready': 'Le modèle Whisper est prêt',
  'Detecting the lyric language': 'Détection de la langue des paroles',
  'Transcribing audio; Whisper does not expose chunk completion': 'Transcription de l’audio ; Whisper n’indique pas la progression des segments',
  'Whisper transcription is validated': 'La transcription Whisper est validée',
  'Committing timed lyrics and language metadata': 'Enregistrement des paroles synchronisées et des métadonnées de langue',
  'Committing timed lyrics and output metadata': 'Enregistrement des paroles synchronisées et des métadonnées de sortie',
  'All four audio versions and timed lyrics are ready': 'Les quatre versions audio et les paroles synchronisées sont prêtes',
  'Requested component is ready; other components remain available or missing': 'L’élément demandé est prêt ; les autres éléments restent disponibles ou manquants',
  'Available outputs are durably saved': 'Les sorties disponibles sont enregistrées durablement',
  'FFmpeg is processing audio': 'FFmpeg traite l’audio',
  'FFmpeg output is complete': 'La sortie FFmpeg est terminée',
  'FFmpeg output path is missing.': 'Le chemin de sortie FFmpeg est manquant.',
  'FFmpeg output target is missing.': 'La cible de sortie FFmpeg est manquante.',
  'FFmpeg did not return an EBU R128 loudness report.': 'FFmpeg n’a pas renvoyé de rapport de volume EBU R128.',
  'FFmpeg returned malformed EBU R128 loudness metrics.': 'FFmpeg a renvoyé des mesures de volume EBU R128 invalides.',
  'The existing vocal output is unavailable.': 'La sortie voix existante est indisponible.',
  'The vocal stem was not produced by the local separation model.': 'Le modèle de séparation local n’a pas produit la piste vocale.',
  'Local Whisper AI could not identify the original lyric language.': 'L’IA Whisper locale n’a pas pu identifier la langue d’origine des paroles.',
  'Local Whisper AI did not find any timed lyrics.': 'L’IA Whisper locale n’a trouvé aucune parole synchronisée.',
  'Local Whisper AI produced an invalid lyrics file.': 'L’IA Whisper locale a produit un fichier de paroles invalide.',
  'Local Whisper AI produced invalid timed lyrics.': 'L’IA Whisper locale a produit des paroles synchronisées invalides.',
  'Whisper could not detect the source language.': 'Whisper n’a pas pu détecter la langue source.',
  'Whisper input is not a valid WAV file.': 'L’entrée Whisper n’est pas un fichier WAV valide.',
  'Whisper input WAV is truncated.': 'Le fichier WAV d’entrée Whisper est tronqué.',
  'Whisper input WAV is missing audio data.': 'Le fichier WAV d’entrée Whisper ne contient pas de données audio.',
  'Whisper input must be 16 kHz mono 16-bit PCM WAV audio.': 'L’entrée Whisper doit être un fichier WAV PCM 16 bits mono à 16 kHz.',
  'Whisper input PCM data is truncated.': 'Les données PCM d’entrée Whisper sont tronquées.',
  'Enhanced output did not reach the measured -16 LUFS target tolerance.': 'La sortie améliorée n’a pas atteint la tolérance cible mesurée de -16 LUFS.',
  'Local AI processing failed.': 'Le traitement par l’IA locale a échoué.',
  'Lyrics and language refresh failed.': 'L’actualisation des paroles et de la langue a échoué.',
  'Processing was interrupted by app shutdown.': 'Le traitement a été interrompu par la fermeture de l’application.',
  'A previously ready artifact is missing or invalid.': 'Un fichier précédemment prêt est manquant ou invalide.',
  'Song is busy with a lyric edit or another local processing job. Retry when it finishes.': 'La chanson est occupée par une modification des paroles ou un autre traitement local. Réessayez à la fin.',
  'That component is already processing.': 'Cet élément est déjà en cours de traitement.',
  'That component is already ready and does not need retrying.': 'Cet élément est déjà prêt et ne nécessite pas de nouvelle tentative.',
  'Lyric timing rematch finished': 'Resynchronisation des paroles terminée',
  'Saved edited lyrics': 'Paroles modifiées enregistrées',
  'Rematch skipped because no vocal stem is available.': 'Resynchronisation ignorée car aucune piste vocale n’est disponible.',
  'Lyric timing rematch is queued. Whisper cannot force-align provided text.': 'La resynchronisation des paroles est en file. Whisper ne peut pas forcer l’alignement du texte fourni.',
  [manualLyricsProtectedMessage]: 'Les paroles manuelles sont protégées contre le remplacement du texte par l’IA.',
  [lyricsBusyMessage]: 'Les paroles sont occupées par un traitement local.',
  [lyricRevisionConflictMessage]: 'Conflit de révision des paroles.',
  'Edited lyrics are empty.': 'Les paroles modifiées sont vides.',
  'Edited lyrics contain no usable lines.': 'Les paroles modifiées ne contiennent aucune ligne utilisable.',
  'LRC timestamps are incomplete or invalid.': 'Les horodatages LRC sont incomplets ou invalides.',
  'Edited lyrics cannot fit a 40ms timeline.': 'Les paroles modifiées ne tiennent pas dans une chronologie de 40 ms.',
  'Unsupported recognition language.': 'Langue de reconnaissance non prise en charge.',
  'Unsupported interface language.': 'Langue d’interface non prise en charge.',
  'The secure desktop bridge did not load. Restart Karaoke Studio.': 'Le pont sécurisé du bureau n’a pas été chargé. Redémarrez Karaoke Studio.',
  'Edit lyrics': 'Modifier les paroles',
  'Cancel lyrics edit': 'Annuler la modification des paroles',
  Update: 'Mettre à jour',
  'Saving…': 'Enregistrement…',
  'Saving edited lyrics…': 'Enregistrement des paroles modifiées…',
  Discard: 'Abandonner',
  'Keep editing': 'Continuer la modification',
  'Discard unsaved lyric edits?': 'Abandonner les modifications non enregistrées des paroles ?',
  'Load saved lyrics': 'Charger les paroles enregistrées',
  'Lyrics saved. Timing rematch is queued and will not replace your text.': 'Paroles enregistrées. La resynchronisation est en file et ne remplacera pas votre texte.',
  'Lyrics saved. Existing timing was kept.': 'Paroles enregistrées. La synchronisation existante a été conservée.',
  'Timing rematch is pending. Your edited text stays as saved.': 'La resynchronisation est en attente. Votre texte modifié reste enregistré.',
  'Timing rematch complete. Edited text was preserved.': 'Resynchronisation terminée. Le texte modifié a été conservé.',
  'Timing rematch failed. Your edited text was kept.': 'La resynchronisation a échoué. Votre texte modifié a été conservé.',
  'Timing rematch failed. Your edited text and existing timing were kept.': 'La resynchronisation a échoué. Votre texte modifié et la synchronisation existante ont été conservés.',
  'Timing rematch skipped. Edited text was kept.': 'Resynchronisation ignorée. Votre texte modifié a été conservé.',
  'Paste or edit the full lyrics. Saved timing stays as a reference and is rematched automatically. AI will not replace this text.': 'Collez ou modifiez les paroles complètes. La synchronisation enregistrée sert de référence puis est réassociée automatiquement. L’IA ne remplacera pas ce texte.',
  Edited: 'Modifiées',
  AI: 'IA',
  'Song recognition': 'Reconnaissance des chansons',
  'Song recognition language mode': 'Mode de langue de reconnaissance des chansons',
  'Manual song recognition language': 'Langue manuelle de reconnaissance des chansons',
  Auto: 'Auto',
  Manual: 'Manuel',
  'Interface language': 'Langue de l’interface',
  'Interface language does not change a song’s saved language.': 'La langue de l’interface ne change pas la langue enregistrée d’une chanson.',
  'Auto detects each song. Manual applies only to new recognition.': 'Auto détecte chaque chanson. Manuel ne s’applique qu’aux nouvelles reconnaissances.',
  Recognition: 'Reconnaissance',
  'percent': 'pour cent',
  'stems': 'pistes',
}

const frenchPatterns: Array<{ re: RegExp; fr: (match: RegExpMatchArray) => string }> = [
  { re: /^(\d+) track ready for your next performance$/, fr: (match) => `${match[1]} titre prêt pour votre prochaine prestation` },
  { re: /^(\d+) tracks ready for your next performance$/, fr: (match) => `${match[1]} titres prêts pour votre prochaine prestation` },
  { re: /^Select (.+) by (.+)$/, fr: (match) => `Sélectionner ${match[1]} par ${match[2]}` },
  { re: /^Add (.+) to a playlist$/, fr: (match) => `Ajouter ${match[1]} à une liste` },
  { re: /^Remove (.+) from library$/, fr: (match) => `Retirer ${match[1]} de la bibliothèque` },
  { re: /^Remove (.+) from (.+)$/, fr: (match) => `Retirer ${match[1]} de ${match[2]}` },
  { re: /^Queued #(\d+)$/, fr: (match) => `En file n°${match[1]}` },
  { re: /^Partial · (\d+) modes$/, fr: (match) => `Partiel · ${match[1]} modes` },
  { re: /^Processing (\d+)%$/, fr: (match) => `Traitement ${match[1]} %` },
  { re: /^Working (\d+)%$/, fr: (match) => `Travail ${match[1]} %` },
  { re: /^(\d+)%$/, fr: (match) => `${match[1]} %` },
  { re: /^ · (\d+)\/(\d+) stems$/, fr: (match) => ` · ${match[1]}/${match[2]} pistes` },
  { re: /^(\d+)s elapsed$/, fr: (match) => `${match[1]} s écoulées` },
  { re: /^(\d+)m (\d+)s elapsed$/, fr: (match) => `${match[1]} min ${match[2]} s écoulées` },
  { re: /^Clear (.+)\?$/, fr: (match) => `Vider ${match[1]} ?` },
  { re: /^Delete (.+)\?$/, fr: (match) => `Supprimer ${match[1]} ?` },
  { re: /^The (.+) version is not available$/, fr: (match) => `La version ${translate('fr', match[1])} n’est pas disponible` },
  { re: /^(.+) became unavailable; continuing with Original\.$/, fr: (match) => `${translate('fr', match[1])} n’est plus disponible ; poursuite avec Originale.` },
  { re: /^(.+) is unavailable for (.+); using Original\.$/, fr: (match) => `${translate('fr', match[1])} n’est pas disponible pour ${match[2]} ; utilisation d’Originale.` },
  { re: /^(Original audio|Enhanced|Vocal|Instrumental) unavailable: ([\s\S]+)$/, fr: (match) => `${translate('fr', match[1])} indisponible : ${translate('fr', match[2])}` },
  { re: /^(.+) unavailable; waiting for (.+)$/, fr: (match) => `${translate('fr', match[1])} indisponible ; en attente de ${translateList(match[2])}` },
  { re: /^(.+) is still processing$/, fr: (match) => `${translate('fr', match[1])} est encore en traitement` },
  { re: /^(.+) has not been created yet$/, fr: (match) => `${translate('fr', match[1])} n’a pas encore été créé` },
  { re: /^Waiting for (.+)$/, fr: (match) => `En attente de ${translateList(match[1])}` },
  { re: /^Unable to retry (.+)$/, fr: (match) => `Impossible de réessayer ${translate('fr', match[1])}` },
  { re: /^Unable to remove (.+)$/, fr: (match) => `Impossible de retirer ${match[1]}` },
  { re: /^Unable to add the song to (.+)$/, fr: (match) => `Impossible d’ajouter la chanson à ${match[1]}` },
  { re: /^Added to (.+)\.$/, fr: (match) => `Ajouté à ${match[1]}.` },
  { re: /^Renamed playlist to (.+)\.$/, fr: (match) => `Liste renommée en ${match[1]}.` },
  { re: /^Created (.+) and added the song\.$/, fr: (match) => `${match[1]} créée et chanson ajoutée.` },
  { re: /^Created (.+)\.$/, fr: (match) => `${match[1]} créée.` },
  { re: /^(.+) lyrics and timing refreshed without re-separating audio\.$/, fr: (match) => `Paroles et synchronisation en ${match[1]} actualisées sans reséparer l’audio.` },
  { re: /^(\d+) lyric line uses fallback timing\. Audio is unaffected; retry lyrics for more precise synchronization\.$/, fr: (match) => `${match[1]} ligne de paroles utilise une synchronisation de repli. L’audio n’est pas affecté ; réessayez les paroles pour une synchronisation plus précise.` },
  { re: /^(\d+) lyric line use fallback timing\. Audio is unaffected; retry lyrics for more precise synchronization\.$/, fr: (match) => `${match[1]} ligne de paroles utilise une synchronisation de repli. L’audio n’est pas affecté ; réessayez les paroles pour une synchronisation plus précise.` },
  { re: /^(\d+) lyric lines use fallback timing\. Audio is unaffected; retry lyrics for more precise synchronization\.$/, fr: (match) => `${match[1]} lignes de paroles utilisent une synchronisation de repli. L’audio n’est pas affecté ; réessayez les paroles pour une synchronisation plus précise.` },
  { re: /^Local AI progress for (.+)$/, fr: (match) => `Progression de l’IA locale pour ${match[1]}` },
  { re: /^Microphone level (\d+) percent$/, fr: (match) => `Niveau du micro ${match[1]} pour cent` },
  { re: /^Monitor output level (\d+) percent$/, fr: (match) => `Niveau de sortie du retour ${match[1]} pour cent` },
  { re: /^Mic monitor level (.+)$/, fr: (match) => `Niveau du retour micro ${translate('fr', match[1])}` },
  { re: /^(\d+)% \(([+-][\d.]+) dB\)$/, fr: (match) => `${match[1]} % (${match[2]} dB)` },
  { re: /^Output ([-\d.]+) LUFS · ([-\d.]+) dBTP$/, fr: (match) => `Sortie ${match[1]} LUFS · ${match[2]} dBTP` },
  { re: /^Vocal ([+-][\d.]+) dB · Instrumental ([+-][\d.]+) dB$/, fr: (match) => `Voix ${match[1]} dB · Instrumentale ${match[2]} dB` },
  { re: /^Vocal ([-+\d.]+) dB$/, fr: (match) => `Voix ${match[1]} dB` },
  { re: /^Instrumental ([-+\d.]+) dB$/, fr: (match) => `Instrumentale ${match[1]} dB` },
  { re: /^Output ([-\d.]+|silent) LUFS \/ ([-\d.]+|no finite) dBTP$/, fr: (match) => `Sortie ${frenchMetric(match[1])} LUFS / ${frenchMetric(match[2])} dBTP` },
  { re: /^EBU R128 · Vocal ([-\d.]+) dB · Instrumental ([-\d.]+) dB · Output (.+) LUFS \/ (.+) dBTP$/, fr: (match) => `EBU R128 · Voix ${match[1]} dB · Instrumentale ${match[2]} dB · Sortie ${frenchMetric(match[3])} LUFS / ${frenchMetric(match[4])} dBTP` },
  { re: /^Queued for local AI processing \(position (\d+)\)$/, fr: (match) => `En file pour le traitement IA local (position ${match[1]})` },
  { re: /^Detecting lyric language sample (\d+) of (\d+)$/, fr: (match) => `Détection de la langue des paroles, échantillon ${match[1]} sur ${match[2]}` },
  { re: /^Demucs processed chunk (\d+) of (\d+)$/, fr: (match) => `Demucs a traité le segment ${match[1]} sur ${match[2]}` },
  { re: /^FFmpeg processed ([\d.]+)s of ([\d.]+)s$/, fr: (match) => `FFmpeg a traité ${match[1]} s sur ${match[2]} s` },
  { re: /^FFmpeg processed ([\d.]+)s$/, fr: (match) => `FFmpeg a traité ${match[1]} s` },
  { re: /^Separation audio: ([\s\S]+)$/, fr: (match) => `Audio de séparation : ${translate('fr', match[1])}` },
  { re: /^Transcription audio: ([\s\S]+)$/, fr: (match) => `Audio de transcription : ${translate('fr', match[1])}` },
  { re: /^(vocals|drums|bass|other) stem (was written|is validated)$/, fr: (match) => `La piste ${frenchStemNames[match[1]]} ${match[2] === 'was written' ? 'a été écrite' : 'est validée'}` },
  { re: /^Loading Whisper model: ([\s\S]+)$/, fr: (match) => `Chargement du modèle Whisper : ${match[1]}` },
  { re: /^Transcribing ([\d.]+)s of audio; Whisper does not expose chunk completion$/, fr: (match) => `Transcription de ${match[1]} s d’audio ; Whisper n’indique pas la progression des segments` },
  { re: /^Whisper completed (\d+) timed word segments$/, fr: (match) => `Whisper a terminé ${match[1]} segments de mots synchronisés` },
  { re: /^Whisper transcription is usable with fallback timing on (\d+) line\(s\)$/, fr: (match) => `La transcription Whisper est utilisable avec une synchronisation de repli sur ${match[1]} ligne(s)` },
  { re: /^(\d+) timed lyric lines are committed$/, fr: (match) => `${match[1]} lignes de paroles synchronisées sont enregistrées` },
  { re: /^(.+) lyrics and timing refreshed$/, fr: (match) => `Paroles et synchronisation en ${match[1]} actualisées` },
  { re: /^Vocal measured ([-\d.]+|silent) LUFS, ([-\d.]+|no finite) dBTP$/, fr: (match) => `Voix mesurée à ${frenchMetric(match[1])} LUFS, ${frenchMetric(match[2])} dBTP` },
  { re: /^Balance selected: Vocal ([-\d.]+) dB, Instrumental ([-\d.]+) dB(; mild measured-noise cleanup enabled)?$/, fr: (match) => `Équilibre choisi : voix ${match[1]} dB, instrumentale ${match[2]} dB${match[3] ? ' ; nettoyage léger du bruit mesuré activé' : ''}` },
  { re: /^Applying two-pass ([-\d.]+) LUFS \/ ([-\d.]+) dBTP master$/, fr: (match) => `Application du mastering en deux passes à ${match[1]} LUFS / ${match[2]} dBTP` },
  { re: /^Premix loudness was ([-\d.]+) LUFS; normalization was skipped to avoid amplifying silence or noise\.$/, fr: (match) => `Le volume du prémix était de ${match[1]} LUFS ; la normalisation a été ignorée pour éviter d’amplifier le silence ou le bruit.` },
  { re: /^Enhanced ready: ([-\d.]+|silent) LUFS, ([-\d.]+|no finite) dBTP$/, fr: (match) => `Version améliorée prête : ${frenchMetric(match[1])} LUFS, ${frenchMetric(match[2])} dBTP` },
  { re: /^Generated output is empty or invalid: ([\s\S]+)$/, fr: (match) => `La sortie générée est vide ou invalide : ${match[1]}` },
  { re: /^Demucs did not produce the (vocals|drums|bass|other) stem\.$/, fr: (match) => `Demucs n’a pas produit la piste ${frenchStemNames[match[1]]}.` },
  { re: /^The local separation model did not produce: (.+)\.$/, fr: (match) => `Le modèle de séparation local n’a pas produit : ${match[1].split(', ').map((stem) => frenchStemNames[stem] ?? stem).join(', ')}.` },
  { re: /^Enhanced true peak ([-\d.]+) dBTP exceeds the -1.5 dBTP ceiling tolerance\.$/, fr: (match) => `La crête réelle de la version améliorée à ${match[1]} dBTP dépasse la tolérance du plafond de -1.5 dBTP.` },
  { re: /^Local AI process exited with code (.+)\.$/, fr: (match) => `Le processus d’IA locale s’est terminé avec le code ${match[1]}.` },
  { re: /^Final library commit failed: ([\s\S]+)$/, fr: (match) => `L’enregistrement final de la bibliothèque a échoué : ${match[1]}` },
  { re: /^Could not persist ([\w-]+): ([\s\S]+)$/, fr: (match) => `Impossible d’enregistrer ${match[1]} : ${match[2]}` },
  { re: /^This component cannot be retried safely: ([\s\S]+)$/, fr: (match) => `Cet élément ne peut pas être réessayé sans risque : ${translate('fr', match[1])}` },
  { re: /^Unsupported song format: ([\s\S]+)$/, fr: (match) => `Format de chanson non pris en charge : ${match[1]}` },
  { re: /^Timing rematch failed\. Your edited text was kept: ([\s\S]+)$/, fr: (match) => `La resynchronisation a échoué. Votre texte modifié a été conservé : ${translate('fr', match[1])}` },
  { re: /^Timing rematch failed\. Your edited text and existing timing were kept: ([\s\S]+)$/, fr: (match) => `La resynchronisation a échoué. Votre texte modifié et la synchronisation existante ont été conservés : ${translate('fr', match[1])}` },
  { re: /^Lyric timing rematch failed: ([\s\S]+)\. Saved lyric text and timing were retained\. Whisper cannot force-align provided text\.(?: Failure status could not be fully persisted: ([\s\S]+))?$/, fr: (match) => `La resynchronisation des paroles a échoué : ${match[1]}. Le texte et la synchronisation enregistrés ont été conservés. Whisper ne peut pas forcer l’alignement du texte fourni.${match[2] ? ` L’état d’échec n’a pas pu être entièrement enregistré : ${match[2]}` : ''}` },
  { re: /^Lyric library save failed: ([\s\S]+)\. lyrics\.json was restored\.$/, fr: (match) => `L’enregistrement des paroles dans la bibliothèque a échoué : ${match[1]}. lyrics.json a été restauré.` },
  { re: /^Lyric library save failed: ([\s\S]+)\. Restoring lyrics\.json also failed: ([\s\S]+)\. lyrics\.json remains the source of truth and will be reapplied on reload\.$/, fr: (match) => `L’enregistrement des paroles dans la bibliothèque a échoué : ${match[1]}. La restauration de lyrics.json a également échoué : ${match[2]}. lyrics.json reste la source de référence et sera réappliqué au rechargement.` },
  { re: /^The selected song changed\. Discard unsaved edits for (.+)\?$/, fr: (match) => `La chanson sélectionnée a changé. Abandonner les modifications non enregistrées pour ${match[1]} ?` },
  { re: /^(\d+) ms output estimate$/, fr: (match) => `estimation de sortie ${match[1]} ms` },
  { re: /^Monitor out (.+)$/, fr: (match) => `Sortie du retour ${match[1]}` },
  { re: /^([^:\n]+): ([\s\S]+)$/, fr: (match) => {
    const left = frenchCopy[match[1]]
    return left ? `${left} : ${translate('fr', match[2])}` : ''
  } },
]

const frenchStemNames: Record<string, string> = { vocals: 'voix', drums: 'batterie', bass: 'basse', other: 'autre' }

function frenchMetric(value: string) {
  return value === 'silent' ? 'silencieux' : value === 'no finite' ? 'non fini' : value
}

function translateList(value: string) {
  return value.split(', ').map((part) => translate('fr', part)).join(', ')
}

export function translate(locale: UiLocale, message: string): string {
  if (locale !== 'fr' || message === '') return message
  const exact = frenchCopy[message]
  if (exact) return exact
  for (const pattern of frenchPatterns) {
    const match = message.match(pattern.re)
    if (!match) continue
    const translated = pattern.fr(match)
    if (translated) return translated
  }
  return message
}

export function translateJoined(locale: UiLocale, message: string): string {
  const progress = message.match(/^([\s\S]+) · (\d+%|\d+s elapsed|\d+m \d+s elapsed)$/)
  if (progress) return `${translateJoined(locale, progress[1])} · ${translate(locale, progress[2])}`
  const translated = translate(locale, message)
  if (translated !== message) return translated
  return message.split(' · ').map((part) => translate(locale, part)).join(' · ')
}

export function localeTag(locale: UiLocale) {
  return locale === 'fr' ? 'fr-FR' : 'en-US'
}

export function isRecognitionLanguageMode(value: string): value is RecognitionLanguageMode {
  return value === 'auto' || value === 'manual'
}
