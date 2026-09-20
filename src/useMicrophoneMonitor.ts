import { useEffect, useRef, useState } from 'react'
import {
  MicrophoneMonitorController,
  type MicrophoneMonitorSnapshot,
} from './microphoneMonitor'

export function useMicrophoneMonitor(playerVolume: number) {
  const controllerRef = useRef<MicrophoneMonitorController | null>(null)
  if (!controllerRef.current) controllerRef.current = new MicrophoneMonitorController()
  const controller = controllerRef.current
  const [snapshot, setSnapshot] = useState<MicrophoneMonitorSnapshot>(controller.getSnapshot())

  useEffect(() => controller.subscribe(setSnapshot), [controller])
  useEffect(() => controller.setPlayerVolume(playerVolume), [controller, playerVolume])

  useEffect(() => {
    const stopForLifecycle = () => void controller.disable()
    const stopWhenHidden = () => {
      if (document.visibilityState === 'hidden') stopForLifecycle()
    }
    window.addEventListener('pagehide', stopForLifecycle)
    window.addEventListener('beforeunload', stopForLifecycle)
    document.addEventListener('visibilitychange', stopWhenHidden)
    return () => {
      window.removeEventListener('pagehide', stopForLifecycle)
      window.removeEventListener('beforeunload', stopForLifecycle)
      document.removeEventListener('visibilitychange', stopWhenHidden)
      void controller.dispose()
    }
  }, [controller])

  return {
    ...snapshot,
    enable: () => controller.enable(),
    disable: () => controller.disable(),
  }
}
