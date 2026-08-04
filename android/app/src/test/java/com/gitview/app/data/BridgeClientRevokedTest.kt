package com.gitview.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The live channel's close-code handling (the `4401` fix that ships with ADR-037).
 *
 * This is the one behaviour in the app deciding whether a de-authorised device re-pairs or hangs
 * forever, and it shipped broken once: the bridge closes a revoked device's socket with [WS_REVOKED],
 * the app treated that as an ordinary drop, and redialled against a token no bridge would ever accept
 * again — "Connection lost — reconnecting…" with no way out and no explanation.
 *
 * It lives in an OkHttp listener plus a retry loop: easy to refactor, and silent when wrong (no crash,
 * just a phone that never recovers). So it is asserted here rather than only demonstrated on an
 * emulator. **Both directions matter** — `4401` must be terminal, and an ordinary close must still
 * redial. A "fix" that stopped retrying on every drop would be worse than the bug it replaced.
 *
 * Uses `runBlocking` rather than `runTest`: the retry loop's real backoff is the thing under test, and
 * the project carries no `kotlinx-coroutines-test` dependency to virtualise it with.
 */
class BridgeClientRevokedTest {

    private lateinit var server: MockWebServer

    /** Accepts the socket, then closes it with [code] the moment the client's auth frame lands. */
    private fun closingWith(code: Int, reason: String) = MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                webSocket.close(code, reason)
            }
        },
    )

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After fun tearDown() {
        server.shutdown()
    }

    @Test fun `a 4401 close is terminal - the client stops dialling and reports REVOKED`() = runBlocking {
        // Several queued on purpose: a client that kept retrying would find a socket waiting each time,
        // and requestCount would climb past 1 — which is exactly what the old code did.
        repeat(4) { server.enqueue(closingWith(WS_REVOKED, "device revoked")) }
        val client = BridgeClient(server.url("/").toString(), "dv_x.secret")
        val job = launch(Dispatchers.IO) { client.connect().collect { } }

        val reached = withTimeoutOrNull(5_000) {
            while (client.state.value != ConnState.REVOKED) delay(20)
            true
        }

        assertTrue("state never settled on REVOKED", reached == true)
        assertEquals(
            "exactly one connection attempt — a revoked token must never be redialled",
            1, server.requestCount,
        )
        // `cancel()` alone returns while the retry loop may still be mid-dial, and tearDown's
        // `server.shutdown()` then races that connection — an intermittent "Gave up waiting for
        // queue to shut down". Join first so no coroutine is left to open another socket.
        job.cancelAndJoin()
        client.close()
    }

    @Test fun `an ordinary close still redials`() = runBlocking {
        // 1000 is a normal close: the bridge restarting, wifi dropping. The token is still good, so the
        // client must keep trying. First retry is ~1s (backoffMs), hence the generous window.
        repeat(4) { server.enqueue(closingWith(1000, "bye")) }
        val client = BridgeClient(server.url("/").toString(), "dv_x.secret")
        val job = launch(Dispatchers.IO) { client.connect().collect { } }

        val redialled = withTimeoutOrNull(8_000) {
            while (server.requestCount < 2) delay(20)
            true
        }

        assertTrue("an ordinary drop must be retried, not treated as terminal", redialled == true)
        assertNotEquals(
            "and a plain disconnect must NOT be reported as revoked",
            ConnState.REVOKED, client.state.value,
        )
        // `cancel()` alone returns while the retry loop may still be mid-dial, and tearDown's
        // `server.shutdown()` then races that connection — an intermittent "Gave up waiting for
        // queue to shut down". Join first so no coroutine is left to open another socket.
        job.cancelAndJoin()
        client.close()
    }
}
