import { defineConfig, externalizeDepsPlugin, bytecodePlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const IS_PROD = process.env.NODE_ENV === 'production'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      // 生产模式编译为 V8 字节码，防逆向
      ...(IS_PROD ? [bytecodePlugin()] : []),
    ],
    build: {
      outDir: 'dist/main',
      minify: IS_PROD ? 'terser' : false,
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [
      externalizeDepsPlugin(),
      ...(IS_PROD ? [bytecodePlugin()] : []),
    ],
    build: {
      outDir: 'dist/preload',
      minify: IS_PROD ? 'terser' : false,
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: path.resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      minify: true,
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
