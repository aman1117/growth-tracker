package com.growthtracker.app.presentation.screens.dashboard

import com.growthtracker.app.domain.model.ActivityType
import com.growthtracker.app.domain.model.Streak
import com.growthtracker.app.domain.model.User
import com.growthtracker.app.presentation.components.ToastData
import java.time.LocalDate

data class DashboardState(
    val currentUsername: String = "",
    val targetUsername: String = "",
    val isReadOnly: Boolean = false,
    val currentDate: LocalDate = LocalDate.now(),
    val activities: Map<ActivityType, Float> = ActivityType.entries.associateWith { 0f },
    val streak: Streak = Streak(0, 0),
    val isLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    
    // Toast
    val toastData: ToastData? = null,
    
    // Activity Modal
    val isModalOpen: Boolean = false,
    val selectedActivity: ActivityType? = null,
    val modalHours: String = "",
    val modalError: String? = null,
    val isSaving: Boolean = false,
    
    // Search
    val isSearchOpen: Boolean = false,
    val searchQuery: String = "",
    val searchResults: List<User> = emptyList(),
    val isSearching: Boolean = false
)

sealed class DashboardEvent {
    data object PreviousDay : DashboardEvent()
    data object NextDay : DashboardEvent()
    data object Refresh : DashboardEvent()
    data class ActivityClicked(val activity: ActivityType) : DashboardEvent()
    data object CloseModal : DashboardEvent()
    data class ModalHoursChanged(val hours: String) : DashboardEvent()
    data object SaveActivity : DashboardEvent()
    data object ToggleSearch : DashboardEvent()
    data class SearchQueryChanged(val query: String) : DashboardEvent()
    data object ClearError : DashboardEvent()
    data object ClearToast : DashboardEvent()
    data object Logout : DashboardEvent()
}
