package com.growthtracker.app

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.growthtracker.app.ui.auth.AuthScreen
import com.growthtracker.app.ui.auth.AuthViewModel
import com.growthtracker.app.ui.dashboard.DashboardScreen
import com.growthtracker.app.ui.dashboard.DashboardViewModel

sealed class Screen(val route: String) {
    object Auth : Screen("auth")
    object Dashboard : Screen("dashboard")
}

@Composable
fun GrowthTrackerApp(
    authViewModel: AuthViewModel,
    dashboardViewModel: DashboardViewModel,
    searchViewModel: com.growthtracker.app.ui.search.SearchViewModel
) {
    val navController = rememberNavController()

    NavHost(
        navController = navController,
        startDestination = Screen.Auth.route
    ) {
        composable(Screen.Auth.route) {
            AuthScreen(
                viewModel = authViewModel,
                onAuthSuccess = {
                    navController.navigate(Screen.Dashboard.route) {
                        popUpTo(Screen.Auth.route) { inclusive = true }
                    }
                }
            )
        }

        composable(Screen.Dashboard.route) {
            DashboardScreen(
                viewModel = dashboardViewModel,
                searchViewModel = searchViewModel,
                onLogout = {
                    authViewModel.logout()
                    navController.navigate(Screen.Auth.route) {
                        popUpTo(Screen.Dashboard.route) { inclusive = true }
                    }
                }
            )
        }
    }
}
