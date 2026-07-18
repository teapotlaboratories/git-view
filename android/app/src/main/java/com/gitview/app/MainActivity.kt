package com.gitview.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import com.gitview.app.ui.AppRoot
import com.gitview.app.ui.theme.DisplayProfileManager
import com.gitview.app.ui.theme.GitViewTheme

/**
 * Single activity. Detects the DisplayProfile (Standard on LCD, Color E-Ink on the Bigme / detected
 * e-ink hardware) with a persisted user override that always wins, then hosts the Compose app.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val profiles = DisplayProfileManager(this)
        setContent {
            val vm: AppViewModel = viewModel()
            GitViewTheme(profiles.active) {
                AppRoot(vm, profiles)
            }
        }
    }
}
