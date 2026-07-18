package com.gitview.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import com.gitview.app.data.BridgeApi
import com.gitview.app.data.BridgeClient

/**
 * Activity-scoped state shared across the nav graph. Phase 0 holds a single in-memory connection;
 * Phase 4 replaces this with a Keystore-backed ConnectionStore of saved bridges.
 */
class AppViewModel : ViewModel() {
    var baseUrl by mutableStateOf("")
        private set
    var token by mutableStateOf("")
        private set

    /** The API client for the active connection, or null until connected. */
    var api: BridgeApi? by mutableStateOf(null)
        private set

    fun connect(url: String, tok: String) {
        baseUrl = url.trim()
        token = tok.trim()
        api = BridgeClient.create(baseUrl, token)
    }
}
