package com.gitview.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Raw palette constants for both display profiles — the SINGLE source of hex values. Both the
 * extended [GitViewColors] tokens and the derived Material 3 ColorSchemes in [GitViewTheme] are
 * built from these, so the two channels can never drift.
 *
 * Standard = dark violet IDE; Color E-Ink = near-mono paper (ink over hue, muted Kaleido 3). See the
 * design handoff (`docs/design/design_handoff_gitview_redesign/README.md` §Design Tokens) and ADR-023.
 */

/** Standard (dark) palette — every role of the spec's Standard color scheme, plus the 0..4 risk ramp. */
internal object StandardPalette {
    val background = Color(0xFF14161B)     // app canvas, editor gutter
    val surface = Color(0xFF181B21)        // bars, cards, sheets
    val surfaceVariant = Color(0xFF1E222A) // inputs, chips, hover
    val border = Color(0xFF262B34)         // hairlines, dividers
    val borderStrong = Color(0xFF2A2F3A)   // raised / focused edges
    val primary = Color(0xFF7F7BF5)        // accent, active nav, send, caret, selection
    val primarySoft = Color(0xFFA99DFF)    // tool names, links on dark
    val onPrimary = Color(0xFF0E0F14)      // text/icon on primary
    val textHi = Color(0xFFE4E7EC)         // titles, code
    val textMid = Color(0xFFCDD2DB)        // body
    val textLow = Color(0xFF8B93A1)        // meta, labels
    val textFaint = Color(0xFF5C6472)      // placeholders, disabled
    val add = Color(0xFF4ED08A)            // success: diff add, online, done
    val remove = Color(0xFFF0736A)         // danger: diff remove, error, destructive
    val warning = Color(0xFFE0A96D)        // medium risk, dirty
    val info = Color(0xFF57A3E8)           // branch, informational

    // Diff line background tints — spec rgba(...,.13): alpha 0.13*255 ≈ 33 = 0x21.
    val addTint = Color(0x214ED08A)        // rgba(78,208,138,.13)
    val removeTint = Color(0x21F0736A)     // rgba(240,115,106,.13)

    // 0..4 risk ramp. None/Low/Medium/Critical reuse info/add/warning/remove; High is the lone new value.
    val riskNone = info                    // 0 None
    val riskLow = add                      // 1 Low
    val riskMedium = warning               // 2 Medium
    val riskHigh = Color(0xFFE8895A)       // 3 High
    val riskCritical = remove              // 4 Critical
}

/**
 * Color E-Ink palette — near-mono paper. The spec deliberately gives NO hue for the semantic roles
 * (add/remove/warning/info/risk): those are carried by weight / strikethrough / filled squares / text
 * badges at the component level, not by color. So the semantic fields resolve to ink here.
 */
internal object EinkPalette {
    val background = Color(0xFFFCFCFA)     // app canvas
    val surface = Color(0xFFFFFFFF)        // cards, bars, sheets
    val surfaceVariant = Color(0xFFF1F1ED) // inputs, selected fill, added-line band
    val border = Color(0xFFC7C7C1)         // hairlines (visible on Kaleido)
    val borderStrong = Color(0xFF8C8C85)   // emphasis rules, focus
    val inkHi = Color(0xFF0A0A0A)          // text, code, icons
    val inkMid = Color(0xFF33332F)         // body
    val inkLow = Color(0xFF63635C)         // meta (min weight 500)
    val accent = Color(0xFF4A4780)         // the ONE muted violet: selection, active tab underline (sparing)
    val onAccent = Color(0xFFFFFFFF)       // text/icon on the accent fill (unstated by spec; white for contrast)
    val paper = Color(0xFFFFFFFF)
}
