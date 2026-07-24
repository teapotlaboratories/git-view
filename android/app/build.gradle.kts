import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Release signing config, loaded from a keystore.properties (gitignored; keystore path + passwords
// never live in the repo). Default is android/keystore.properties; override the file location with the
// `keystorePropsFile` Gradle property or the GITVIEW_KEYSTORE_PROPS env var (tools/release.sh --keystore*
// use this) — the secrets stay inside the pointed-at file, never on the command line. Absent on CI / a
// fresh checkout → release stays unsigned, debug is unaffected.
val keystorePropsOverride = (findProperty("keystorePropsFile") as String?) ?: System.getenv("GITVIEW_KEYSTORE_PROPS")
val keystorePropsFile = keystorePropsOverride?.let { file(it) } ?: rootProject.file("keystore.properties")
val keystoreProps = Properties().apply { if (keystorePropsFile.exists()) load(FileInputStream(keystorePropsFile)) }

android {
    namespace = "com.gitview.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.gitview.app"
        minSdk = 26          // Sora LSP needs 26; Bigme B7 Pro runs Android 14 (API 34)
        targetSdk = 34
        versionCode = 7
        versionName = "0.1.6"
        vectorDrawables { useSupportLibrary = true }
    }

    signingConfigs {
        create("release") {
            if (keystorePropsFile.exists()) {
                storeFile = file(keystoreProps["storeFile"] as String)
                storePassword = keystoreProps["storePassword"] as String
                keyAlias = keystoreProps["keyAlias"] as String
                keyPassword = keystoreProps["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Sign with the release key only when keystore.properties is present; else stays unsigned.
            signingConfig = if (keystorePropsFile.exists()) signingConfigs.getByName("release") else null
        }
    }

    compileOptions {
        // Sora's TextMate module needs desugaring below API 33 (see docs/DECISIONS.md ADR-013).
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/DEPENDENCIES")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    implementation(libs.androidx.security.crypto)
    implementation(libs.coil.compose)

    // Markdown rendering for assistant chat text (CommonMark + Compose M3 renderer).
    implementation(libs.richtext.commonmark)
    implementation(libs.richtext.ui.material3)

    // Sora Editor (LGPL-2.1) — VS Code-grade highlighting via TextMate + tree-sitter.
    implementation(platform(libs.sora.editor.bom))
    implementation(libs.sora.editor)
    implementation(libs.sora.language.textmate)
    implementation(libs.sora.language.treesitter)
    implementation(libs.sora.oniguruma.native)

    coreLibraryDesugaring(libs.desugar.jdk.libs)

    testImplementation(libs.junit)
}
