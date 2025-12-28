package com.growthtracker.app.presentation.screens.splash

import androidx.lifecycle.ViewModel
import com.growthtracker.app.domain.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject

@HiltViewModel
class SplashViewModel @Inject constructor(
    private val authRepository: AuthRepository
) : ViewModel() {

    val isLoggedIn: Flow<Boolean> = authRepository.isLoggedIn()
}
