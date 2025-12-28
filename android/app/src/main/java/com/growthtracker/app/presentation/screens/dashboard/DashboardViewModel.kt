package com.growthtracker.app.presentation.screens.dashboard

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.growthtracker.app.domain.model.ActivityType
import com.growthtracker.app.domain.repository.ActivityRepository
import com.growthtracker.app.domain.repository.AuthRepository
import com.growthtracker.app.domain.repository.StreakRepository
import com.growthtracker.app.domain.repository.UserRepository
import com.growthtracker.app.presentation.components.ToastData
import com.growthtracker.app.presentation.components.ToastType
import com.growthtracker.app.util.Resource
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import javax.inject.Inject

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val activityRepository: ActivityRepository,
    private val streakRepository: StreakRepository,
    private val userRepository: UserRepository,
    savedStateHandle: SavedStateHandle
) : ViewModel() {

    private val _state = MutableStateFlow(DashboardState())
    val state: StateFlow<DashboardState> = _state.asStateFlow()

    private val dateFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")
    private var searchJob: Job? = null
    
    // Get username from navigation argument if present
    private val routeUsername: String? = savedStateHandle["username"]

    init {
        viewModelScope.launch {
            val currentUsername = authRepository.getCurrentUsername().first() ?: ""
            val targetUsername = routeUsername ?: currentUsername
            
            _state.update { 
                it.copy(
                    currentUsername = currentUsername,
                    targetUsername = targetUsername,
                    isReadOnly = routeUsername != null && routeUsername != currentUsername
                ) 
            }
            loadData()
        }
    }

    fun setTargetUser(username: String) {
        val currentUsername = _state.value.currentUsername
        _state.update { 
            it.copy(
                targetUsername = username,
                isReadOnly = username != currentUsername,
                currentDate = LocalDate.now(),
                activities = ActivityType.entries.associateWith { 0f }
            ) 
        }
        loadData()
    }

    fun onEvent(event: DashboardEvent) {
        when (event) {
            is DashboardEvent.PreviousDay -> {
                _state.update { it.copy(currentDate = it.currentDate.minusDays(1)) }
                loadData()
            }
            is DashboardEvent.NextDay -> {
                val today = LocalDate.now()
                if (_state.value.currentDate.isBefore(today)) {
                    _state.update { it.copy(currentDate = it.currentDate.plusDays(1)) }
                    loadData()
                }
            }
            is DashboardEvent.Refresh -> {
                _state.update { it.copy(isRefreshing = true) }
                loadData()
            }
            is DashboardEvent.ActivityClicked -> {
                if (!_state.value.isReadOnly && !_state.value.currentDate.isAfter(LocalDate.now())) {
                    val currentHours = _state.value.activities[event.activity] ?: 0f
                    _state.update { 
                        it.copy(
                            isModalOpen = true,
                            selectedActivity = event.activity,
                            modalHours = if (currentHours > 0) currentHours.toString() else "",
                            modalError = null
                        ) 
                    }
                }
            }
            is DashboardEvent.CloseModal -> {
                _state.update { 
                    it.copy(
                        isModalOpen = false,
                        selectedActivity = null,
                        modalHours = "",
                        modalError = null
                    ) 
                }
            }
            is DashboardEvent.ModalHoursChanged -> {
                _state.update { it.copy(modalHours = event.hours) }
            }
            is DashboardEvent.SaveActivity -> {
                saveActivity()
            }
            is DashboardEvent.ToggleSearch -> {
                _state.update { 
                    it.copy(
                        isSearchOpen = !it.isSearchOpen,
                        searchQuery = "",
                        searchResults = emptyList()
                    ) 
                }
            }
            is DashboardEvent.SearchQueryChanged -> {
                _state.update { it.copy(searchQuery = event.query) }
                searchUsers(event.query)
            }
            is DashboardEvent.ClearError -> {
                _state.update { it.copy(error = null) }
            }
            is DashboardEvent.ClearToast -> {
                _state.update { it.copy(toastData = null) }
            }
            is DashboardEvent.Logout -> {
                viewModelScope.launch {
                    authRepository.logout()
                }
            }
        }
    }
    
    private fun showToast(message: String, type: ToastType) {
        _state.update { it.copy(toastData = ToastData(message = message, type = type)) }
    }

    private fun loadData() {
        viewModelScope.launch {
            val targetUsername = _state.value.targetUsername
            val dateStr = _state.value.currentDate.format(dateFormatter)

            _state.update { it.copy(isLoading = true) }

            // Load activities
            when (val result = activityRepository.getActivities(targetUsername, dateStr)) {
                is Resource.Success -> {
                    val activityMap = ActivityType.entries.associateWith { 0f }.toMutableMap()
                    result.data.forEach { activity ->
                        activity.activityType?.let { type ->
                            activityMap[type] = activity.hours
                        }
                    }
                    _state.update { it.copy(activities = activityMap) }
                }
                is Resource.Error -> {
                    _state.update { it.copy(error = result.message) }
                }
                is Resource.Loading -> {}
            }

            // Load streak
            when (val result = streakRepository.getStreak(targetUsername, dateStr)) {
                is Resource.Success -> {
                    _state.update { it.copy(streak = result.data) }
                }
                is Resource.Error -> {
                    // Silently fail for streak
                }
                is Resource.Loading -> {}
            }

            _state.update { it.copy(isLoading = false, isRefreshing = false) }
        }
    }

    private fun saveActivity() {
        val currentState = _state.value
        val activity = currentState.selectedActivity ?: return
        val hoursStr = currentState.modalHours

        // Validation
        val hours = hoursStr.toFloatOrNull()
        if (hours == null || hours < 0 || hours > 24) {
            _state.update { it.copy(modalError = "Please enter a valid number between 0 and 24") }
            return
        }

        // Check if multiple of 0.25
        val remainder = (hours * 100) % 25
        if (remainder != 0f) {
            _state.update { it.copy(modalError = "Hours must be in increments of 0.25") }
            return
        }

        // Check total hours
        val totalOtherHours = currentState.activities
            .filter { it.key != activity }
            .values.sum()
        if (totalOtherHours + hours > 24) {
            _state.update { it.copy(modalError = "Total hours cannot exceed 24") }
            return
        }

        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, modalError = null) }

            val dateStr = currentState.currentDate.format(dateFormatter)
            val result = activityRepository.createActivity(
                username = currentState.targetUsername,
                activityName = activity.apiName,
                hours = hours,
                date = dateStr
            )

            when (result) {
                is Resource.Success -> {
                    // Optimistic update
                    _state.update { state ->
                        val updatedActivities = state.activities.toMutableMap()
                        updatedActivities[activity] = hours
                        state.copy(
                            activities = updatedActivities,
                            isModalOpen = false,
                            selectedActivity = null,
                            modalHours = "",
                            isSaving = false
                        )
                    }
                    showToast("${activity.displayName} saved!", ToastType.SUCCESS)
                    // Refresh streak
                    loadStreak()
                }
                is Resource.Error -> {
                    _state.update { it.copy(modalError = result.message, isSaving = false) }
                    showToast(result.message, ToastType.ERROR)
                }
                is Resource.Loading -> {}
            }
        }
    }

    private fun loadStreak() {
        viewModelScope.launch {
            val targetUsername = _state.value.targetUsername
            val dateStr = _state.value.currentDate.format(dateFormatter)
            when (val result = streakRepository.getStreak(targetUsername, dateStr)) {
                is Resource.Success -> {
                    _state.update { it.copy(streak = result.data) }
                }
                is Resource.Error -> {}
                is Resource.Loading -> {}
            }
        }
    }

    private fun searchUsers(query: String) {
        searchJob?.cancel()
        if (query.isBlank()) {
            _state.update { it.copy(searchResults = emptyList(), isSearching = false) }
            return
        }

        searchJob = viewModelScope.launch {
            delay(300) // Debounce
            _state.update { it.copy(isSearching = true) }

            when (val result = userRepository.searchUsers(query)) {
                is Resource.Success -> {
                    _state.update { it.copy(searchResults = result.data, isSearching = false) }
                }
                is Resource.Error -> {
                    _state.update { it.copy(searchResults = emptyList(), isSearching = false) }
                }
                is Resource.Loading -> {}
            }
        }
    }
}
