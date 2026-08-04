package com.gitview.app.ui.kicad

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Turning surface normals into the tangent frames Filament wants (ADR-038, Phase 4a.3).
 *
 * Filament's `TANGENTS` vertex attribute is **not** a normal. It is a float4 quaternion encoding the
 * whole tangent frame, and the shader recovers the normal by rotating `+Z` with it. Binding raw float3
 * normals there is accepted by every layer — it compiles, it binds, it draws — and simply lights the
 * model wrongly, which is the kind of bug that gets shipped because the picture is not blank.
 *
 * Our meshes have no texture coordinates, so the tangent and bitangent are unconstrained: any frame
 * whose Z axis is the normal shades identically under an isotropic material. So we build an arbitrary
 * orthonormal basis around the normal and convert that to a quaternion.
 */

/**
 * Build one quaternion per vertex from `normals`, or a flat +Z frame when the mesh has none.
 *
 * Returns `vertexCount * 4` floats, `(x, y, z, w)` per vertex.
 */
fun tangentFrames(normals: FloatArray?, vertexCount: Int): FloatArray {
    val out = FloatArray(vertexCount * 4)
    if (normals == null || normals.size < vertexCount * 3) {
        // No normals: identity, i.e. every normal points at +Z. Flat and obviously lit-from-front rather
        // than randomly shaded — a legible degradation instead of noise.
        for (v in 0 until vertexCount) out[v * 4 + 3] = 1f
        return out
    }
    for (v in 0 until vertexCount) {
        val q = frameFromNormal(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2])
        q.copyInto(out, v * 4)
    }
    return out
}

/**
 * A quaternion rotating `+Z` onto `(nx, ny, nz)`.
 *
 * The basis is built with the Frisvad-style trick of choosing whichever axis is *least* aligned with the
 * normal as the seed for the cross product. Using a fixed seed axis instead produces a degenerate,
 * zero-length tangent exactly when the normal is parallel to it — a whole face of a box, not a rare edge
 * case, and it shows up as one side rendering black.
 */
fun frameFromNormal(nx: Float, ny: Float, nz: Float): FloatArray {
    // Normalise defensively: a tessellator can emit a denormal, and every step below assumes unit length.
    val len = sqrt(nx * nx + ny * ny + nz * nz)
    if (len < 1e-8f) return floatArrayOf(0f, 0f, 0f, 1f)
    val zx = nx / len; val zy = ny / len; val zz = nz / len

    val ax = abs(zx); val ay = abs(zy); val az = abs(zz)
    val sx: Float; val sy: Float; val sz: Float
    if (ax <= ay && ax <= az) { sx = 1f; sy = 0f; sz = 0f }
    else if (ay <= az) { sx = 0f; sy = 1f; sz = 0f }
    else { sx = 0f; sy = 0f; sz = 1f }

    // x = normalize(cross(seed, z)); y = cross(z, x)
    var xx = sy * zz - sz * zy
    var xy = sz * zx - sx * zz
    var xz = sx * zy - sy * zx
    val xl = sqrt(xx * xx + xy * xy + xz * xz)
    if (xl < 1e-8f) return floatArrayOf(0f, 0f, 0f, 1f)
    xx /= xl; xy /= xl; xz /= xl
    val yx = zy * xz - zz * xy
    val yy = zz * xx - zx * xz
    val yz = zx * xy - zy * xx

    // Matrix (columns x, y, z) → quaternion, branching on the largest diagonal term so the divisor is
    // never near zero. The naive single-branch conversion loses all precision at 180° rotations.
    val m00 = xx; val m01 = yx; val m02 = zx
    val m10 = xy; val m11 = yy; val m12 = zy
    val m20 = xz; val m21 = yz; val m22 = zz
    val trace = m00 + m11 + m22
    var qx: Float; var qy: Float; var qz: Float; var qw: Float
    if (trace > 0f) {
        val s = sqrt(trace + 1f) * 2f
        qw = 0.25f * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s
    } else if (m00 > m11 && m00 > m22) {
        val s = sqrt(1f + m00 - m11 - m22) * 2f
        qw = (m21 - m12) / s; qx = 0.25f * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s
    } else if (m11 > m22) {
        val s = sqrt(1f + m11 - m00 - m22) * 2f
        qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25f * s; qz = (m12 + m21) / s
    } else {
        val s = sqrt(1f + m22 - m00 - m11) * 2f
        qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25f * s
    }
    val ql = sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if (ql < 1e-8f) return floatArrayOf(0f, 0f, 0f, 1f)
    qx /= ql; qy /= ql; qz /= ql; qw /= ql
    // Filament stores the frame's handedness in the sign of w, and reads it back with `w >= 0` meaning
    // right-handed. Ours always is, so keep w positive rather than letting the conversion pick a sign.
    return if (qw < 0f) floatArrayOf(-qx, -qy, -qz, -qw) else floatArrayOf(qx, qy, qz, qw)
}

/** Rotate `+Z` by a frame quaternion — the shader's own operation, used by tests to check round-trip. */
fun normalFromFrame(q: FloatArray): FloatArray {
    val (x, y, z, w) = listOf(q[0], q[1], q[2], q[3])
    return floatArrayOf(
        2f * (x * z + w * y),
        2f * (y * z - w * x),
        1f - 2f * (x * x + y * y),
    )
}
