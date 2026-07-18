package com.gitview.app.editor

import android.content.Context
import android.util.Log
import io.github.rosemoe.sora.langs.textmate.TextMateColorScheme
import io.github.rosemoe.sora.langs.textmate.TextMateLanguage
import io.github.rosemoe.sora.langs.textmate.registry.FileProviderRegistry
import io.github.rosemoe.sora.langs.textmate.registry.GrammarRegistry
import io.github.rosemoe.sora.langs.textmate.registry.ThemeRegistry
import io.github.rosemoe.sora.langs.textmate.registry.model.DefaultGrammarDefinition
import io.github.rosemoe.sora.langs.textmate.registry.model.ThemeModel
import io.github.rosemoe.sora.langs.textmate.registry.provider.AssetsFileResolver
import io.github.rosemoe.sora.widget.schemes.EditorColorScheme
import org.eclipse.tm4e.core.registry.IGrammarSource
import org.eclipse.tm4e.core.registry.IThemeSource

/**
 * VS Code-grade syntax highlighting via Sora's TextMate registry. Bundles real VS Code grammars
 * (assets/textmate/grammars, from shikijs/textmate-grammars-themes, MIT) + the Dark+ theme,
 * and the e-ink weight/underline theme. One-time [init]; then per file we pick a grammar by
 * extension and a theme by DisplayProfile.
 *
 * If anything fails to load, [ready] stays false and the editor falls back to plain monospace —
 * highlighting is an enhancement, never a hard dependency.
 */
object SyntaxHighlighting {
    const val THEME_DARK = "dark-plus"
    const val THEME_LIGHT = "light-plus"
    const val THEME_EINK = "eink-mono"

    @Volatile var ready = false
        private set

    /** Language name -> (asset file, tm scope). */
    private data class Lang(val file: String, val scope: String)

    // Extension -> grammar. Scopes captured from the bundled grammars.
    private val byExt: Map<String, Lang> = buildMap {
        fun put(scope: String, file: String, vararg exts: String) = exts.forEach { this[it] = Lang(file, scope) }
        put("source.kotlin", "kotlin", "kt", "kts")
        put("source.java", "java", "java")
        put("source.ts", "typescript", "ts", "mts", "cts")
        put("source.tsx", "tsx", "tsx")
        put("source.js", "javascript", "js", "mjs", "cjs")
        put("source.js.jsx", "jsx", "jsx")
        put("source.python", "python", "py", "pyi")
        put("source.json", "json", "json")
        put("source.json.comments", "jsonc", "jsonc")
        put("text.html.markdown", "markdown", "md", "markdown")
        put("source.yaml", "yaml", "yml", "yaml")
        put("text.xml", "xml", "xml")
        put("text.html.basic", "html", "html", "htm")
        put("source.css", "css", "css")
        put("source.shell", "shellscript", "sh", "bash", "zsh")
        put("source.toml", "toml", "toml")
        put("source.c", "c", "c", "h")
        put("source.cpp", "cpp", "cpp", "cc", "cxx", "hpp", "hh")
        put("source.go", "go", "go")
        put("source.rust", "rust", "rs")
        put("source.sql", "sql", "sql")
        put("source.groovy", "groovy", "groovy", "gradle")
        put("source.diff", "diff", "diff", "patch")
    }

    private val allGrammars: List<Lang> get() = byExt.values.distinctBy { it.scope }

    @Synchronized
    fun init(context: Context) {
        if (ready) return
        val assets = context.applicationContext.assets
        try {
            // Use native Oniguruma so grammars with look-behind (TS, Kotlin, …) tokenize correctly;
            // the pure-Java Joni engine rejects those patterns. No-op if the native lib is missing.
            runCatching {
                org.eclipse.tm4e.core.internal.oniguruma.Oniguruma().setUseNativeOniguruma(true)
                Log.i("Highlight", "native oniguruma available=" +
                    org.eclipse.tm4e.core.internal.oniguruma.impl.onig.NativeOnigConfig.isAvailable())
            }

            FileProviderRegistry.getInstance().addFileProvider(AssetsFileResolver(assets))

            val themes = ThemeRegistry.getInstance()
            themes.loadTheme(themeModel(assets, "textmate/themes/dark-plus.json", THEME_DARK, dark = true))
            themes.loadTheme(themeModel(assets, "textmate/themes/light-plus.json", THEME_LIGHT, dark = false))
            themes.loadTheme(themeModel(assets, "textmate/eink-mono.json", THEME_EINK, dark = false))

            val defs: List<io.github.rosemoe.sora.langs.textmate.registry.model.GrammarDefinition> =
                allGrammars.map { l ->
                    val src = IGrammarSource.fromInputStream(
                        assets.open("textmate/grammars/${l.file}.json"), "${l.file}.json", null,
                    )
                    DefaultGrammarDefinition.withGrammarSource(src, l.file, l.scope)
                }
            GrammarRegistry.getInstance().loadGrammars(defs)
            ready = true
            Log.i("Highlight", "TextMate ready: ${defs.size} grammars, 3 themes")
        } catch (t: Throwable) {
            Log.e("Highlight", "TextMate init failed; falling back to plain text", t)
            ready = false
        }
    }

    private fun themeModel(assets: android.content.res.AssetManager, path: String, name: String, dark: Boolean): ThemeModel {
        val src = IThemeSource.fromInputStream(assets.open(path), path.substringAfterLast('/'), null)
        return ThemeModel(src, name).apply { setDark(dark) }
    }

    fun scopeForPath(path: String): String? {
        val ext = path.substringAfterLast('.', "").lowercase()
        return byExt[ext]?.scope
    }

    /** A color scheme for the given DisplayProfile-appropriate theme, or null if not ready. */
    fun colorScheme(themeName: String): EditorColorScheme? {
        if (!ready) return null
        return try {
            ThemeRegistry.getInstance().setTheme(themeName)
            TextMateColorScheme.create(ThemeRegistry.getInstance())
        } catch (t: Throwable) {
            Log.e("Highlight", "colorScheme($themeName) failed", t); null
        }
    }

    /** A TextMate language for the file at [path], or null if unsupported / not ready. */
    fun languageForPath(path: String): TextMateLanguage? {
        val scope = scopeForPath(path) ?: return null
        if (!ready) return null
        return try {
            TextMateLanguage.create(scope, true)
        } catch (t: Throwable) {
            Log.e("Highlight", "languageForPath($path) failed", t); null
        }
    }
}
