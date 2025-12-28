package com.growthtracker.app.presentation.navigation

sealed class Screen(val route: String) {
    data object Splash : Screen("splash")
    data object Login : Screen("login")
    data object Dashboard : Screen("dashboard")
    data object UserDashboard : Screen("user_dashboard/{username}") {
        fun createRoute(username: String) = "user_dashboard/$username"
    }
}
