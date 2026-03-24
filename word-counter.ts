import { TFile, App } from 'obsidian';
import { WordCountSettings } from './settings';

/**
 * 字数统计核心类
 */
export class WordCounter {
    constructor(private app: App, private settings: WordCountSettings) { }

    /**
     * 统计文件的词数（中英文混合）
     * 中文：按字数统计
     * 英文：按单词统计
     * @param file 要统计的文件
     * @returns 词数
     */
    async countWords(file: TFile): Promise<number> {
        const content = await this.app.vault.read(file);
        return this.countWordsInContent(content);
    }

    /**
     * 统计内容的词数
     * @param content 文本内容
     * @returns 词数
     */
    countWordsInContent(content: string): number {
        // 移除frontmatter
        content = this.removeFrontmatter(content);

        // 移除代码块
        content = content.replace(/```[\s\S]*?```/g, '');

        // 移除行内代码
        content = content.replace(/`[^`]*`/g, '');

        // 移除链接markdown语法
        content = content.replace(/\[([^\]]*)\]\([^\)]*\)/g, '$1');

        // 统计中文字符
        const chineseChars = content.match(/[\u4e00-\u9fa5]/g);
        const chineseCount = chineseChars ? chineseChars.length : 0;

        // 移除中文字符后统计英文单词
        const nonChinese = content.replace(/[\u4e00-\u9fa5]/g, ' ');
        const englishWords = nonChinese.match(/[a-zA-Z]+/g);
        const englishCount = englishWords ? englishWords.length : 0;

        return chineseCount + englishCount;
    }

    /**
     * 移除frontmatter
     */
    private removeFrontmatter(content: string): string {
        const frontmatterRegex = /^---\n[\s\S]*?\n---\n/;
        return content.replace(frontmatterRegex, '');
    }

    /**
     * 检查文件是否应该被统计（根据文件夹过滤规则）
     * @param file 要检查的文件
     * @returns 是否应该统计
     */
    shouldCountFile(file: TFile): boolean {
        const filePath = file.path;

        // 检查排除文件夹
        if (this.settings.excludeFolders.length > 0) {
            for (const excludeFolder of this.settings.excludeFolders) {
                if (filePath.startsWith(excludeFolder)) {
                    return false;
                }
            }
        }

        // 检查包含文件夹
        if (this.settings.includeFolders.length > 0) {
            for (const includeFolder of this.settings.includeFolders) {
                if (filePath.startsWith(includeFolder)) {
                    return true;
                }
            }
            return false; // 如果设置了包含文件夹，但文件不在其中
        }

        return true; // 默认统计所有文件
    }


    /**
     * 获取文件的缓存字数
     */
    getCachedWordCount(file: TFile, settings: WordCountSettings): { lastCount: number; lastUpdateDate: string } {
        const cache = settings.wordCountCache[file.path];
        return cache || { lastCount: 0, lastUpdateDate: '' };
    }

    /**
     * 更新文件缓存
     */
    updateCache(file: TFile, wordCount: number, date: string, settings: WordCountSettings): void {
        settings.wordCountCache[file.path] = {
            lastCount: wordCount,
            lastUpdateDate: date
        };
    }
}
