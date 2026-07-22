package com.gitview.app.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * Profile-aware Material 3 [Shapes]. Standard = 12dp cards/sheets, 8dp chips/inputs; Color E-Ink = a
 * uniform 6dp language. ALL FIVE slots are set per profile on purpose: M3's `extraLarge` defaults to
 * 28dp and flows into `ModalBottomSheet`'s expanded shape, which would break the E-Ink 6dp language
 * if left unset.
 *
 * The fully-rounded send button is a SEPARATE token ([SendPillShape]) — a 50% pill is not part of the
 * 5-slot ramp. On E-Ink the composer uses the 6dp language instead of the pill.
 */
private val StandardShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),  // chips / inputs
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),     // cards
    large = RoundedCornerShape(12.dp),      // sheets
    extraLarge = RoundedCornerShape(12.dp), // bottom-sheet expanded — flatten from M3's 28dp default
)

private val EinkShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(6.dp),
    large = RoundedCornerShape(6.dp),
    extraLarge = RoundedCornerShape(6.dp),
)

/** Fully-rounded pill for the send button (Standard, 999dp ⇒ 50%). */
val SendPillShape = RoundedCornerShape(percent = 50)

fun profileShapes(profile: DisplayProfile): Shapes = if (profile.isEink) EinkShapes else StandardShapes
