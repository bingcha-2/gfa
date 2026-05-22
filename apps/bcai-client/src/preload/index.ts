/**
 * Preload script — 安全桥接 Electron 主进程和渲染进程
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  /** 发送操作到主进程 */
  send: (type: string, payload?: any) => {
    ipcRenderer.send('rosetta-action', { type, payload })
  },

  /** 监听状态更新 */
  onStateUpdate: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state)
    ipcRenderer.on('rosetta:state', handler)
    return () => ipcRenderer.removeListener('rosetta:state', handler)
  },

  /** 监听通知 */
  onNotification: (callback: (msg: string) => void) => {
    const handler = (_event: any, msg: string) => callback(msg)
    ipcRenderer.on('rosetta:notification', handler)
    return () => ipcRenderer.removeListener('rosetta:notification', handler)
  },

  /** 监听自动升级状态 */
  onUpdateStatus: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status)
    ipcRenderer.on('rosetta:updateStatus', handler)
    return () => ipcRenderer.removeListener('rosetta:updateStatus', handler)
  },
})
