package com.growthtracker.app.ui.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.growthtracker.app.data.model.ActivityType
import com.growthtracker.app.data.model.StreakData
import com.growthtracker.app.data.repository.GrowthTrackerRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

data class DashboardUiState(
    val isLoading: Boolean = false,
    val currentDate: Date = Date(),
    val activities: Map<ActivityType, Double> = emptyMap(),
    val streak: StreakData = StreakData(0, 0),
    val username: String = "",
    val viewingUsername: String = "",
    val isViewingOtherUser: Boolean = false,
    val error: String? = null,
    val selectedActivity: ActivityType? = null,
    val showActivityDialog: Boolean = false,
    val successMessage: String? = null
)

class DashboardViewModel(private val repository: GrowthTrackerRepository) : ViewModel() {
    private val _uiState = MutableStateFlow(DashboardUiState())
    val uiState: StateFlow<DashboardUiState> = _uiState.asStateFlow()

    private val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    init {
        loadUsername()
    }

    private fun loadUsername() {
        viewModelScope.launch {
            val username = repository.getCurrentUsername()
            if (username != null) {
                _uiState.value = _uiState.value.copy(
                    username = username,
                    viewingUsername = username
                )
                loadActivities()
                loadStreak()
            }
        }
    }

    fun viewUserProfile(username: String) {
        _uiState.value = _uiState.value.copy(
            viewingUsername = username,
            isViewingOtherUser = username != _uiState.value.username,
            currentDate = Date()
        )
        loadActivities()
        loadStreak()
    }

    fun returnToOwnProfile() {
        _uiState.value = _uiState.value.copy(
            viewingUsername = _uiState.value.username,
            isViewingOtherUser = false,
            currentDate = Date()
        )
        loadActivities()
        loadStreak()
    }

    fun loadActivities() {
        val state = _uiState.value
        if (state.viewingUsername.isEmpty()) return

        viewModelScope.launch {
            _uiState.value = state.copy(isLoading = true, error = null)
            
            val dateStr = dateFormat.format(state.currentDate)
            android.util.Log.d("DashboardVM", "Loading activities for $dateStr, username: ${state.viewingUsername}")
            val result = repository.getActivities(state.viewingUsername, dateStr, dateStr)
            
            result.onSuccess { activities ->
                android.util.Log.d("DashboardVM", "Received ${activities.size} activities")
                val activityMap = mutableMapOf<ActivityType, Double>()
                
                ActivityType.values().forEach { type ->
                    activityMap[type] = 0.0
                }
                
                activities.forEach { activity ->
                    android.util.Log.d("DashboardVM", "Activity: ${activity.name} = ${activity.hours}h")
                    val type = ActivityType.fromApiName(activity.name)
                    activityMap[type] = activity.hours
                }
                
                _uiState.value = state.copy(
                    isLoading = false,
                    activities = activityMap
                )
            }.onFailure { error ->
                android.util.Log.e("DashboardVM", "Load activities failed: ${error.message}")
                _uiState.value = state.copy(
                    isLoading = false,
                    error = error.message ?: "Failed to load activities"
                )
            }
        }
    }

    fun loadStreak() {
        val state = _uiState.value
        if (state.viewingUsername.isEmpty()) return

        viewModelScope.launch {
            val dateStr = dateFormat.format(state.currentDate)
            val result = repository.getStreak(state.viewingUsername, dateStr)
            
            result.onSuccess { streak ->
                _uiState.value = _uiState.value.copy(streak = streak)
            }.onFailure {
                // Silent failure for streak
            }
        }
    }

    fun navigateToPreviousDay() {
        val calendar = Calendar.getInstance()
        calendar.time = _uiState.value.currentDate
        calendar.add(Calendar.DAY_OF_YEAR, -1)
        
        _uiState.value = _uiState.value.copy(currentDate = calendar.time)
        loadActivities()
        loadStreak()
    }

    fun navigateToNextDay() {
        val calendar = Calendar.getInstance()
        calendar.time = _uiState.value.currentDate
        calendar.add(Calendar.DAY_OF_YEAR, 1)
        
        val today = Calendar.getInstance()
        if (calendar.before(today) || calendar.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)) {
            _uiState.value = _uiState.value.copy(currentDate = calendar.time)
            loadActivities()
            loadStreak()
        }
    }

    fun isNextDayDisabled(): Boolean {
        val today = Calendar.getInstance()
        val current = Calendar.getInstance()
        current.time = _uiState.value.currentDate
        
        return current.get(Calendar.YEAR) == today.get(Calendar.YEAR) &&
                current.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)
    }

    fun showActivityDialog(activity: ActivityType) {
        if (_uiState.value.isViewingOtherUser) return
        
        _uiState.value = _uiState.value.copy(
            selectedActivity = activity,
            showActivityDialog = true,
            error = null,
            successMessage = null
        )
    }

    fun hideActivityDialog() {
        _uiState.value = _uiState.value.copy(
            selectedActivity = null,
            showActivityDialog = false,
            error = null
        )
    }

    fun saveActivity(hours: Double) {
        val state = _uiState.value
        val selectedActivity = state.selectedActivity ?: return

        if (hours < 0 || hours > 24) {
            _uiState.value = state.copy(error = "Hours must be between 0 and 24")
            return
        }

        val remainder = (hours * 100) % 25
        if (remainder != 0.0) {
            _uiState.value = state.copy(error = "Hours must be in increments of 0.25")
            return
        }

        viewModelScope.launch {
            _uiState.value = state.copy(isLoading = true)
            
            val dateStr = dateFormat.format(state.currentDate)
            val activityName = ActivityType.toApiName(selectedActivity)
            
            android.util.Log.d("DashboardVM", "Saving activity: $activityName, hours: $hours, date: $dateStr, username: ${state.username}")
            
            val result = repository.createActivity(
                state.username,
                activityName,
                hours,
                dateStr
            )
            
            result.onSuccess {
                android.util.Log.d("DashboardVM", "Activity saved successfully")
                val updatedActivities = state.activities.toMutableMap()
                updatedActivities[selectedActivity] = hours
                
                _uiState.value = state.copy(
                    isLoading = false,
                    activities = updatedActivities,
                    showActivityDialog = false,
                    selectedActivity = null,
                    successMessage = "Activity saved successfully"
                )
                
                viewModelScope.launch {
                    kotlinx.coroutines.delay(2000)
                    _uiState.value = _uiState.value.copy(successMessage = null)
                }
            }.onFailure { error ->
                _uiState.value = state.copy(
                    isLoading = false,
                    error = error.message ?: "Failed to save activity"
                )
            }
        }
    }

    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }

    fun clearSuccessMessage() {
        _uiState.value = _uiState.value.copy(successMessage = null)
    }
}
