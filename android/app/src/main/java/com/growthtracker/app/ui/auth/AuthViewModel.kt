package com.growthtracker.app.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.growthtracker.app.data.repository.GrowthTrackerRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class AuthUiState(
    val isLoading: Boolean = false,
    val isLogin: Boolean = true,
    val email: String = "",
    val username: String = "",
    val password: String = "",
    val error: String? = null,
    val isAuthenticated: Boolean = false
)

class AuthViewModel(private val repository: GrowthTrackerRepository) : ViewModel() {
    private val _uiState = MutableStateFlow(AuthUiState())
    val uiState: StateFlow<AuthUiState> = _uiState.asStateFlow()

    init {
        checkAuthStatus()
    }

    private fun checkAuthStatus() {
        viewModelScope.launch {
            val isLoggedIn = repository.isLoggedIn()
            _uiState.value = _uiState.value.copy(isAuthenticated = isLoggedIn)
        }
    }

    fun toggleAuthMode() {
        _uiState.value = _uiState.value.copy(
            isLogin = !_uiState.value.isLogin,
            error = null
        )
    }

    fun updateEmail(email: String) {
        _uiState.value = _uiState.value.copy(email = email, error = null)
    }

    fun updateUsername(username: String) {
        _uiState.value = _uiState.value.copy(username = username, error = null)
    }

    fun updatePassword(password: String) {
        _uiState.value = _uiState.value.copy(password = password, error = null)
    }

    fun login() {
        val state = _uiState.value
        if (state.username.isEmpty() || state.password.isEmpty()) {
            _uiState.value = state.copy(error = "Please fill in all fields")
            return
        }

        viewModelScope.launch {
            _uiState.value = state.copy(isLoading = true, error = null)
            
            val result = repository.login(state.username, state.password)
            result.onSuccess {
                _uiState.value = AuthUiState(isAuthenticated = true)
            }.onFailure { error ->
                _uiState.value = state.copy(
                    isLoading = false,
                    error = error.message ?: "Login failed"
                )
            }
        }
    }

    fun register() {
        val state = _uiState.value
        if (state.email.isEmpty() || state.username.isEmpty() || state.password.isEmpty()) {
            _uiState.value = state.copy(error = "Please fill in all fields")
            return
        }

        if (state.password.length < 8) {
            _uiState.value = state.copy(error = "Password must be at least 8 characters")
            return
        }

        viewModelScope.launch {
            _uiState.value = state.copy(isLoading = true, error = null)
            
            val result = repository.register(state.email, state.username, state.password)
            result.onSuccess {
                _uiState.value = AuthUiState(isAuthenticated = true)
            }.onFailure { error ->
                _uiState.value = state.copy(
                    isLoading = false,
                    error = error.message ?: "Registration failed"
                )
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            repository.logout()
            _uiState.value = AuthUiState()
        }
    }
}
