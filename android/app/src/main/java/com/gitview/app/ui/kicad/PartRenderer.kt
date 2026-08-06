package com.gitview.app.ui.kicad

import android.view.Choreographer
import android.view.TextureView
import com.google.android.filament.Box
import com.google.android.filament.Camera
import com.google.android.filament.Engine
import com.google.android.filament.EntityManager
import com.google.android.filament.Filament
import com.google.android.filament.IndexBuffer
import com.google.android.filament.LightManager
import com.google.android.filament.Material
import com.google.android.filament.MaterialInstance
import com.google.android.filament.RenderableManager
import com.google.android.filament.Renderer
import com.google.android.filament.Scene
import com.google.android.filament.Skybox
import com.google.android.filament.SwapChain
import com.google.android.filament.VertexBuffer
import com.google.android.filament.View
import com.google.android.filament.Viewport
import com.google.android.filament.android.UiHelper
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Drawing converted KiCad parts with Filament (ADR-038, Phase 4a.3).
 *
 * **Why an engine at all, and why only its core.** Tessellating STEP happens on a host, ahead of time
 * (Phase 4a.1); this end only has to draw triangles. Filament's *core* is 3.4 MB compressed and gives
 * correct lighting for far less code than a hand-written GL pipeline. Its glTF loader is **not** here —
 * 11 MB to parse a format we generate ourselves, which `GlbReader` already reads — and neither is its
 * runtime material compiler at 9.5 MB, because `part.filamat` is compiled ahead of time and committed at
 * 41 KB.
 *
 * **Everything Filament allocates is off-heap and must be released explicitly.** Engine resources are
 * not garbage collected: a `VertexBuffer` that goes out of scope leaks until the process dies. Every
 * `create*` here has a matching destroy in [release], and the order matters — renderables before the
 * buffers they point at, everything before the engine.
 */
class PartRenderer(
    private val materialBytes: ByteArray,
    /**
     * Backdrop and unpainted-part colour for the theme this viewer is drawn in — see [viewerPalette].
     * Passed in rather than read here because Filament draws outside Compose and cannot reach
     * `MaterialTheme`, and hardcoding it is what left the viewport the same grey slab on every profile.
     */
    private val palette: ViewerPalette,
) {

    private lateinit var engine: Engine
    private lateinit var renderer: Renderer
    private lateinit var scene: Scene
    private lateinit var view: View
    private lateinit var camera: Camera
    private lateinit var material: Material
    private var swapChain: SwapChain? = null
    private var uiHelper: UiHelper? = null
    private var cameraEntity = 0
    private val lights = mutableListOf<Int>()
    private val renderables = mutableListOf<Int>()
    private val vertexBuffers = mutableListOf<VertexBuffer>()
    private val indexBuffers = mutableListOf<IndexBuffer>()
    private val instances = mutableListOf<MaterialInstance>()

    /** Orbit state, in the units the camera uses. Driven by gestures from the composable. */
    var yaw = 0.6f
    var pitch = 0.5f
    var distance = 1f
        set(v) { field = v.coerceIn(radius * 0.05f, radius * 40f); userMoved = true }

    private var radius = 1f
    private var pendingModel: GlbModel? = null
    private var currentModel: GlbModel? = null
    private var aspect = 1f
    /** True once a gesture has moved the view, so auto-framing stops fighting the user. */
    private var userMoved = false
    private var center = floatArrayOf(0f, 0f, 0f)
    private var ready = false

    /**
     * Attach to a [TextureView], not a `SurfaceView`.
     *
     * Measured on a physical device, not chosen on style: a `SurfaceView` hosted by Compose's
     * `AndroidView` in this tree is laid out (1080x1840 at 0,0), attached and VISIBLE — and its
     * `surfaceCreated` never fires, so no surface is ever produced and SurfaceFlinger holds no layer for
     * it. Proven with Filament removed entirely and a bare `lockCanvas` fill, which also never appeared.
     *
     * A `TextureView` composites as an ordinary view in the hierarchy instead of as a separate
     * compositor layer, so none of that machinery is involved. It costs an extra copy per frame, which
     * is irrelevant for a part viewer drawing a few thousand triangles.
     */
    fun attach(textureView: TextureView, uiHelper: UiHelper) {
        // Re-entrant on purpose. `PartViewer` remembers this renderer across recompositions while
        // `AndroidView`'s factory runs again whenever the view is recreated — a rotation, for one, on the
        // tablet this feature targets. Creating a second Engine there would orphan the first along with
        // every buffer it owns, and Filament's allocations are off-heap and never collected. So the
        // engine is built once and later calls only re-bind the surface.
        if (ready) {
            this.uiHelper?.detach()
            bindSurface(textureView, uiHelper)
            return
        }
        // MUST come before any other Filament call. `Filament.init()` is what loads
        // `libfilament-jni.so`; without it the very first engine call dies with
        // `UnsatisfiedLinkError: No implementation found for Engine.nCreateBuilder()`.
        //
        // Nothing on the JVM can catch this — the entire engine is native, so unit tests never reach it
        // and the crash only appears the first time a human opens the viewer. It is guarded rather than
        // called blindly so repeated opens do not re-enter the loader.
        if (!nativeLoaded) { Filament.init(); nativeLoaded = true }
        engine = Engine.create()
        renderer = engine.createRenderer()
        scene = engine.createScene()
        view = engine.createView()
        cameraEntity = EntityManager.get().create()
        camera = engine.createCamera(cameraEntity)
        view.scene = scene
        view.camera = camera
        // A flat backdrop rather than a transparent one: an unlit black viewport is indistinguishable
        // from a viewer that failed to load anything. Its colour comes from the active theme, so the
        // e-ink profile gets a paper-white ground instead of the dark theme's.
        scene.skybox = Skybox.Builder()
            .color(palette.backdrop.first, palette.backdrop.second, palette.backdrop.third, 1.0f)
            .build(engine)
        material = Material.Builder().payload(
            ByteBuffer.allocateDirect(materialBytes.size).order(ByteOrder.nativeOrder())
                .put(materialBytes).apply { flip() },
            materialBytes.size,
        ).build(engine)
        addLights()
        bindSurface(textureView, uiHelper)
        ready = true
        applyPending()
    }

    /** Wire a helper to a view and take its surface. Shared by first attach and re-attach. */
    private fun bindSurface(textureView: TextureView, uiHelper: UiHelper) {
        this.uiHelper = uiHelper
        uiHelper.renderCallback = object : UiHelper.RendererCallback {
            override fun onNativeWindowChanged(surface: android.view.Surface) {
                swapChain?.let { engine.destroySwapChain(it) }
                swapChain = engine.createSwapChain(surface)
            }
            override fun onDetachedFromSurface() {
                swapChain?.let { engine.destroySwapChain(it); engine.flushAndWait(); swapChain = null }
            }
            override fun onResized(width: Int, height: Int) {
                view.viewport = Viewport(0, 0, width, height)
                aspect = if (height > 0) width.toFloat() / height else 1f
                camera.setProjection(FOV_DEGREES.toDouble(), aspect.toDouble(), 0.05, 10_000.0, Camera.Fov.VERTICAL)
                // Re-frame on resize too: the first layout arrives after the model on a cold open, and a
                // rotation changes which axis is the limiting one.
                if (!userMoved) frame()
            }
        }
        uiHelper.attachTo(textureView)
    }

    /**
     * Two directional lights, no image-based lighting.
     *
     * IBL would mean shipping a KTX environment map — more assets for a viewer whose subject is matte
     * plastic and metal. Two lights (a key and a dimmer fill from behind) are enough to keep an
     * unlit face from reading as a hole in the model, which one light alone does not.
     */
    private fun addLights() {
        fun light(dirX: Float, dirY: Float, dirZ: Float, lux: Float) {
            val e = EntityManager.get().create()
            LightManager.Builder(LightManager.Type.DIRECTIONAL)
                .color(1f, 1f, 1f)
                .intensity(lux)
                .direction(dirX, dirY, dirZ)
                .castShadows(false)   // the material is compiled without the shadow-receiver variant
                .build(engine, e)
            scene.addEntity(e)
            lights += e
        }
        light(0.5f, -1f, -0.8f, 90_000f)
        light(-0.6f, 0.4f, 0.7f, 35_000f)
    }

    /**
     * Replace what is on screen with [model]. Old geometry is destroyed, not orphaned.
     *
     * Deferred rather than dropped when the engine is not up yet: the caller composes before the
     * `AndroidView` factory necessarily runs, so a model arriving first must be remembered, not lost.
     * Idempotent for the same instance, which is what stops the first model being built, destroyed and
     * rebuilt when both the factory and a `LaunchedEffect` ask for it.
     */
    fun setModel(model: GlbModel) {
        if (model === currentModel) return
        pendingModel = model
        if (ready) applyPending()
    }

    private fun applyPending() {
        val model = pendingModel ?: return
        pendingModel = null
        currentModel = model
        clearGeometry()

        for (p in model.primitives) {
            val vertexCount = p.positions.size / 3
            val pos = direct(p.positions)

            // Filament wants a tangent FRAME, not a normal: `TANGENTS` is a float4 quaternion that
            // rotates +Z onto the surface normal. Handing it raw float3 normals compiles, binds, and
            // lights the model wrongly — see `tangentFrames`.
            val frames = tangentFrames(p.normals, vertexCount)
            val vb = VertexBuffer.Builder()
                .bufferCount(2)
                .vertexCount(vertexCount)
                .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 12)
                .attribute(VertexBuffer.VertexAttribute.TANGENTS, 1, VertexBuffer.AttributeType.FLOAT4, 0, 16)
                .build(engine)
            vb.setBufferAt(engine, 0, pos)
            vb.setBufferAt(engine, 1, direct(frames))

            val idx = ByteBuffer.allocateDirect(p.indices.size * 4).order(ByteOrder.nativeOrder())
            for (i in p.indices) idx.putInt(i)
            idx.flip()
            val ib = IndexBuffer.Builder()
                .indexCount(p.indices.size)
                .bufferType(IndexBuffer.Builder.IndexType.UINT)
                .build(engine)
            ib.setBuffer(engine, idx)

            val mi = material.createInstance().apply {
                // Parts whose STEP file carried no colour take the theme's fallback, which is solved to
                // contrast with the backdrop above rather than fixed at a light grey that only worked
                // on a dark ground.
                val c = p.color ?: palette.part
                setParameter("baseColor", c.first, c.second, c.third, 1f)
                setParameter("roughness", 0.55f)
                setParameter("metallic", 0.05f)
            }

            val entity = EntityManager.get().create()
            RenderableManager.Builder(1)
                .boundingBox(Box(model.center(), model.halfExtent()))
                .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, vb, ib, 0, p.indices.size)
                .material(0, mi)
                .culling(false)
                .build(engine, entity)
            scene.addEntity(entity)

            renderables += entity; vertexBuffers += vb; indexBuffers += ib; instances += mi
        }

        // Frame the part: centre the orbit on its bounds and pull back far enough to see all of it.
        center = model.center()
        radius = max(0.001f, model.halfExtent().let { sqrt(it[0] * it[0] + it[1] * it[1] + it[2] * it[2]) })
        // A new part is framed afresh, and its orientation starts from the default rather than inheriting
        // however the previous one happened to be rotated — which read as the viewer being stuck.
        yaw = 0.6f
        pitch = 0.5f
        userMoved = false
        frame()
    }

    /** Pull the camera back far enough for the whole part to fit the current viewport. */
    private fun frame() {
        distance = fitDistance(radius, FOV_DEGREES, aspect)
    }

    private fun direct(a: FloatArray): ByteBuffer {
        val b = ByteBuffer.allocateDirect(a.size * 4).order(ByteOrder.nativeOrder())
        for (v in a) b.putFloat(v)
        b.flip()
        return b
    }

    fun render(frameTimeNanos: Long) {
        val sc = swapChain ?: return
        val eye = floatArrayOf(
            center[0] + distance * cos(pitch) * sin(yaw),
            center[1] + distance * sin(pitch),
            center[2] + distance * cos(pitch) * cos(yaw),
        )
        camera.lookAt(
            eye[0].toDouble(), eye[1].toDouble(), eye[2].toDouble(),
            center[0].toDouble(), center[1].toDouble(), center[2].toDouble(),
            0.0, 1.0, 0.0,
        )
        // `beginFrame` returning false means Filament wants this frame skipped — its frame skipper caps
        // how many are in flight. Under the emulator's software renderer it refuses the large majority
        // (measured: 91 drawn against 3,028 refused), which is a property of SwiftShader's frame times,
        // not an error to react to.
        if (renderer.beginFrame(sc, frameTimeNanos)) {
            renderer.render(view)
            renderer.endFrame()
        }
    }

    private fun clearGeometry() {
        for (e in renderables) { scene.removeEntity(e); engine.destroyEntity(e); EntityManager.get().destroy(e) }
        for (v in vertexBuffers) engine.destroyVertexBuffer(v)
        for (i in indexBuffers) engine.destroyIndexBuffer(i)
        for (m in instances) engine.destroyMaterialInstance(m)
        renderables.clear(); vertexBuffers.clear(); indexBuffers.clear(); instances.clear()
    }

    /** Order matters: renderables, then the buffers they referenced, then the engine itself. */
    fun release() {
        if (!ready) return
        ready = false
        clearGeometry()
        uiHelper?.detach()
        uiHelper = null
        for (e in lights) { scene.removeEntity(e); engine.destroyEntity(e); EntityManager.get().destroy(e) }
        lights.clear()
        scene.skybox?.let { engine.destroySkybox(it) }
        engine.destroyMaterial(material)
        swapChain?.let { engine.destroySwapChain(it) }
        engine.destroyRenderer(renderer)
        engine.destroyView(view)
        engine.destroyScene(scene)
        engine.destroyCameraComponent(cameraEntity)
        EntityManager.get().destroy(cameraEntity)
        engine.destroy()
    }

    companion object {
        @Volatile private var nativeLoaded = false

        /** Vertical field of view. Shared by the projection and the framing maths, which must agree. */
        const val FOV_DEGREES = 45f

        /** Drives [render] from the display's own vsync. */
        fun choreographer(onFrame: (Long) -> Unit): Choreographer.FrameCallback =
            object : Choreographer.FrameCallback {
                override fun doFrame(frameTimeNanos: Long) {
                    onFrame(frameTimeNanos)
                    Choreographer.getInstance().postFrameCallback(this)
                }
            }
    }
}

/** Bounds helpers, kept beside the renderer because they exist for framing rather than for geometry. */
fun GlbModel.center(): FloatArray =
    floatArrayOf((min[0] + max[0]) / 2f, (min[1] + max[1]) / 2f, (min[2] + max[2]) / 2f)

fun GlbModel.halfExtent(): FloatArray =
    floatArrayOf(
        max(1e-4f, (max[0] - min[0]) / 2f),
        max(1e-4f, (max[1] - min[1]) / 2f),
        max(1e-4f, (max[2] - min[2]) / 2f),
    )
