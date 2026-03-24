import { ColorWithOpacity } from './settings';

/**
 * 颜色渐变工具类
 * 实现字数统计的渐变色逻辑
 */
export class ColorGradient {
    /**
     * 将 HEX 颜色和透明度转换为 RGBA
     * @param hex HEX 颜色值，如 "#9be9a8"
     * @param opacity 透明度，范围 0-100
     * @returns RGBA 颜色值
     */
    private static hexToRgba(hex: string, opacity: number): string {
        // 移除 # 号
        hex = hex.replace('#', '');
        
        // 解析 RGB
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        
        // 转换透明度（0-100 -> 0-1）
        const alpha = opacity / 100;
        
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    /**
     * 根据字数和目标计算渐变色
     * @param wordCount 当前字数
     * @param goal 目标字数
     * @param colors 颜色配置对象
     * @returns 颜色值 (RGBA)
     */
    static getColor(
        wordCount: number,
        goal: number,
        colors: {
            empty: ColorWithOpacity;
            level1: ColorWithOpacity;
            level2: ColorWithOpacity;
            level3: ColorWithOpacity;
            level4: ColorWithOpacity;
        }
    ): string {
        if (wordCount === 0) {
            return this.hexToRgba(colors.empty.color, colors.empty.opacity);
        }

        const ratio = wordCount / goal;

        if (ratio < 0.4) {
            return this.hexToRgba(colors.level1.color, colors.level1.opacity);
        } else if (ratio < 0.7) {
            return this.hexToRgba(colors.level2.color, colors.level2.opacity);
        } else if (ratio < 1.0) {
            return this.hexToRgba(colors.level3.color, colors.level3.opacity);
        } else {
            return this.hexToRgba(colors.level4.color, colors.level4.opacity);
        }
    }
}
