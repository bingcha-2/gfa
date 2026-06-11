import type { Dict } from './zh-CN'

/** 翻译文件类型:允许暂缺键(运行时回退简中)。 */
export type DeepPartialDict = DeepPartialOf<Dict>

type DeepPartialOf<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartialOf<T[K]>
      : T[K]
}
