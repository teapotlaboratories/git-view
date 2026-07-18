pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Sora Editor and some grammars are published via JitPack.
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "GitView"
include(":app")
