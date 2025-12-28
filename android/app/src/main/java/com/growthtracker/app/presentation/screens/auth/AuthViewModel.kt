package com.growthtracker.app.presentation.screens.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.growthtracker.app.domain.repository.AuthRepository
import com.growthtracker.app.presentation.components.ToastData
import com.growthtracker.app.presentation.components.ToastType
import com.growthtracker.app.util.Resource
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val authRepository: AuthRepository
) : ViewModel() {

    private val _state = MutableStateFlow(AuthState())
    val state: StateFlow<AuthState> = _state.asStateFlow()

    fun onEvent(event: AuthEvent) {
        when (event) {
            is AuthEvent.ToggleAuthMode -> {
                _state.update { it.copy(isLogin = !it.isLogin, error = null) }
            }
            is AuthEvent.EmailChanged -> {
                _state.update { it.copy(email = event.email) }
            }
            is AuthEvent.UsernameChanged -> {
                _state.update { it.copy(username = event.username) }
            }
            is AuthEvent.PasswordChanged -> {
                _state.update { it.copy(password = event.password) }
            }
            is AuthEvent.Submit -> {
                submit()
            }
            is AuthEvent.ClearError -> {
                _state.update { it.copy(error = null) }
            }
            is AuthEvent.ClearToast -> {
                _state.update { it.copy(toastData = null) }
            }
        }
    }
    
    private fun showToast(message: String, type: ToastType) {
        _state.update { it.copy(toastData = ToastData(message = message, type = type)) }
    }

    private fun submit() {
        val currentState = _state.value
        
        // Validation
        if (currentState.username.isBlank()) {
            showToast("Username is required", ToastType.WARNING)
            return
        }
        if (currentState.password.isBlank()) {
            showToast("Password is required", ToastType.WARNING)
            return
        }
        if (currentState.password.length < 8) {
            showToast("Password must be at least 8 characters", ToastType.WARNING)
            return
        }
        if (!currentState.isLogin && currentState.email.isBlank()) {
            showToast("Email is required", ToastType.WARNING)
            return
        }

        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            val result = if (currentState.isLogin) {
                authRepository.login(currentState.username, currentState.password)
            } else {
                authRepository.register(currentState.email, currentState.username, currentState.password)
            }

            when (result) {
                is Resource.Success -> {
                    _state.update { it.copy(isLoading = false, isSuccess = true) }
                    showToast("Welcome back!", ToastType.SUCCESS)
                }
                is Resource.Error -> {
                    _state.update { it.copy(isLoading = false) }
                    showToast(result.message, ToastType.ERROR)
                }
                is Resource.Loading -> {
                    // Already handled
                }
            }
        }
    }
}
