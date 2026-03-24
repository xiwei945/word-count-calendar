export interface WordCountCache {
    [filePath: string]: {
        lastCount: number;
        lastUpdateDate: string;
    };
}

/**
 * 颜色和透明度配置
 */
export interface ColorWithOpacity {
    color: string;      // HEX 颜色值，如 "#9be9a8"
    opacity: number;    // 透明度，范围 0-100
}

export interface WordCountSettings {
    dailyGoal: number;
    includeFolders: string[];
    excludeFolders: string[];
    dailyNotesFolder: string;
    wordCountCache: WordCountCache;
    dailyNotePaths: { [dateStr: string]: string }; // 缓存日记文件路径

    // 格子颜色配置
    emptyCellColor: ColorWithOpacity;  // 无数据格子颜色
    level1Color: ColorWithOpacity;     // Level 1: < 40% 目标
    level2Color: ColorWithOpacity;     // Level 2: 40% - 70% 目标
    level3Color: ColorWithOpacity;     // Level 3: 70% - 100% 目标
    level4Color: ColorWithOpacity;     // Level 4: ≥ 100% 目标

    // 格子大小配置
    cellSize: number;  // 格子大小（像素），范围 30-80

    // 日记模板配置
    dailyNoteTemplate: string;  // 日记模板文件路径
}

export const DEFAULT_SETTINGS: WordCountSettings = {
    dailyGoal: 1000,
    includeFolders: [],
    excludeFolders: [],
    dailyNotesFolder: '',
    wordCountCache: {},
    dailyNotePaths: {},

    // 默认颜色（GitHub 绿色系）
    emptyCellColor: { color: '#ebedf0', opacity: 100 },
    level1Color: { color: '#9be9a8', opacity: 100 },
    level2Color: { color: '#40c463', opacity: 100 },
    level3Color: { color: '#30a14e', opacity: 100 },
    level4Color: { color: '#216e39', opacity: 100 },

    // 默认格子大小
    cellSize: 45,

    // 默认日记模板（留空表示不使用模板）
    dailyNoteTemplate: ''
}
