package com.growthtracker.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.growthtracker.app.data.api.RetrofitClient
import com.growthtracker.app.data.preferences.UserPreferences
import com.growthtracker.app.data.repository.GrowthTrackerRepository
import com.growthtracker.app.ui.auth.AuthViewModel
import com.growthtracker.app.ui.dashboard.DashboardViewModel
import com.growthtracker.app.ui.theme.GrowthTrackerTheme

class MainActivity : ComponentActivity() {
    
    private lateinit var authViewModel: AuthViewModel
    private lateinit var dashboardViewModel: DashboardViewModel
    private lateinit var searchViewModel: com.growthtracker.app.ui.search.SearchViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Install splash screen
        installSplashScreen()

        // Initialize dependencies
        val userPreferences = UserPreferences(applicationContext)
        val repository = GrowthTrackerRepository(
            RetrofitClient.apiService,
            userPreferences
        )

        // Initialize ViewModels
        authViewModel = AuthViewModel(repository)
        dashboardViewModel = DashboardViewModel(repository)
        searchViewModel = com.growthtracker.app.ui.search.SearchViewModel(repository)

        setContent {
            GrowthTrackerTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    GrowthTrackerApp(
                        authViewModel = authViewModel,
                        dashboardViewModel = dashboardViewModel,
                        searchViewModel = searchViewModel
                    )
                }
            }
        }
    }
}
