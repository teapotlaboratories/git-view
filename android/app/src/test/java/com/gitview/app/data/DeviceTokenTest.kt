package com.gitview.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * ADR-035 token parsing. This drives "which row is me" in the paired-devices list — and therefore
 * whether the app offers a Revoke the bridge would answer with 403.
 */
class DeviceTokenTest {

    @Test fun `a new-format token yields its device id`() {
        assertEquals("dv_mFO5XYiT", deviceIdOf("dv_mFO5XYiT.9xKqAbCdEfGhIjKlMnOpQrStUvWxYz0123456789"))
    }

    @Test fun `a pre-0_1_8 bare token yields no id at all`() {
        // ADR-037: no bridge accepts a dotless token any more, so there is no row it could name. Empty
        // rather than the old shared "legacy" id — which, if returned, would match a stale bridge's
        // synthetic row and withhold a Revoke the operator is entitled to.
        assertEquals("", deviceIdOf("bOaVjDuM9wEdWejRCQQ0R0ivvqWFWqF__4uDJPyCcPE"))
    }

    @Test fun `only the first dot separates id from secret`() {
        // base64url never contains ".", but splitting on the LAST dot would corrupt the id if it did.
        assertEquals("dv_abc", deviceIdOf("dv_abc.secret.with.dots"))
    }

    @Test fun `degenerate tokens do not throw`() {
        assertEquals("", deviceIdOf(""))
        assertEquals("", deviceIdOf(".secretOnly"))
        assertEquals("dv_abc", deviceIdOf("dv_abc."))
    }

    @Test fun `ids from different bridges are distinct, so one must not be reused for another`() {
        // Each bridge mints its own id for the same physical device. Carrying one across a bridge
        // switch would mark the wrong row (or no row) as "this device".
        val onBridgeA = deviceIdOf("dv_aaaaaa.secretA")
        val onBridgeB = deviceIdOf("dv_bbbbbb.secretB")
        assertNotEquals(onBridgeA, onBridgeB)
    }
}
