package com.gitview.app.ui.permission

import com.gitview.app.data.PermissionProfile

/**
 * The redesigned permission tiers: a plain-language name, the raw profile it replaces (`was`), a 0..4
 * risk level + label, and a description — one per wire [PermissionProfile], ordered by escalating risk.
 * Compose-free so it unit-tests on the JVM. See the design handoff §Permission model.
 */
data class TierInfo(
    val profile: PermissionProfile,
    val name: String,
    val was: String,
    val risk: Int,          // 0..4
    val riskLabel: String,
    val description: String,
    val allows: String,
    val holdToConfirm: Boolean = false,
)

val PERMISSION_TIERS: List<TierInfo> = listOf(
    TierInfo(
        PermissionProfile.READ_ONLY, "Read-only", "read-only", 0, "None",
        "Read, search, analyze. All writes & commands are refused.", "Read · search · analyze",
    ),
    TierInfo(
        PermissionProfile.CONFINED_AGENT, "Ask first", "confined", 1, "Low",
        "Prompts on every edit & command — nothing runs without your OK.", "Nothing without your OK",
    ),
    TierInfo(
        PermissionProfile.ACCEPT_EDITS, "Auto-edit", "acceptEdits", 2, "Medium",
        "Create/edit/delete in the repo; prompts before any command.", "Create / edit / delete in repo",
    ),
    TierInfo(
        PermissionProfile.AUTO, "Auto-run", "auto", 3, "High",
        "Edits + safe commands; prompts on destructive / outside-repo.", "Edits + safe commands",
    ),
    TierInfo(
        PermissionProfile.DONT_ASK, "No prompts", "dontAsk", 3, "High",
        "Edits + commands with no prompts. Still confined to the repo dir.", "Edits + commands, no prompts",
    ),
    TierInfo(
        PermissionProfile.BYPASS, "Unrestricted", "bypass", 4, "Critical",
        "Anything, anywhere on the host. No sandbox — hold to confirm.", "Anything, anywhere",
        holdToConfirm = true,
    ),
)

fun tierOf(profile: PermissionProfile): TierInfo =
    PERMISSION_TIERS.firstOrNull { it.profile == profile } ?: PERMISSION_TIERS[1]
