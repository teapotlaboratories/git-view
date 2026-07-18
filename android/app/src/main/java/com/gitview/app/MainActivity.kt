package com.gitview.app

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.gitview.app.ui.ConnectScreen
import com.gitview.app.ui.FileScreen
import com.gitview.app.ui.ReposScreen
import com.gitview.app.ui.TreeScreen
import com.gitview.app.ui.theme.GitViewTheme

/**
 * Single-activity host. Phase 0 nav graph: Connect → Repos → Tree → File.
 * The AppViewModel is created once at activity scope and shared across destinations.
 * Editor + Chat tabs arrive in later phases (see docs/PLAN.md).
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { GitViewTheme { Surface(Modifier.fillMaxSize()) { App() } } }
    }
}

@Composable
private fun App() {
    val nav = rememberNavController()
    val app: AppViewModel = viewModel() // activity-scoped: one shared instance

    NavHost(navController = nav, startDestination = "connect") {
        composable("connect") {
            ConnectScreen(app) { nav.navigate("repos") }
        }
        composable("repos") {
            ReposScreen(
                app,
                onOpenRepo = { repo -> nav.navigate("tree?repo=$repo&path=") },
                onBack = { nav.popBackStack() },
            )
        }
        composable(
            route = "tree?repo={repo}&path={path}",
            arguments = listOf(
                navArgument("repo") { type = NavType.StringType; defaultValue = "" },
                navArgument("path") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { entry ->
            val repo = entry.arguments?.getString("repo").orEmpty()
            val path = entry.arguments?.getString("path").orEmpty()
            TreeScreen(
                app, repo, path,
                onOpenDir = { p -> nav.navigate("tree?repo=$repo&path=${Uri.encode(p)}") },
                onOpenFile = { p -> nav.navigate("file?repo=$repo&path=${Uri.encode(p)}") },
                onBack = { nav.popBackStack() },
            )
        }
        composable(
            route = "file?repo={repo}&path={path}",
            arguments = listOf(
                navArgument("repo") { type = NavType.StringType; defaultValue = "" },
                navArgument("path") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { entry ->
            val repo = entry.arguments?.getString("repo").orEmpty()
            val path = entry.arguments?.getString("path").orEmpty()
            FileScreen(app, repo, path) { nav.popBackStack() }
        }
    }
}
