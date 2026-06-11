import type { Dict } from "./zh-CN";

/** 翻译文件类型:允许暂缺键(运行时回退简中);数组按整体替换。 */
export type DeepPartialDict = {
  [K in keyof Dict]?: Dict[K] extends readonly unknown[]
    ? Dict[K]
    : Dict[K] extends object
      ? DeepPartialOf<Dict[K]>
      : Dict[K];
};

type DeepPartialOf<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartialOf<T[K]>
      : T[K];
};
