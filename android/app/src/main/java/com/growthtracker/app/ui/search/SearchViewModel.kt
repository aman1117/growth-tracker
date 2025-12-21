package com.growthtracker.app.ui.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.growthtracker.app.data.model.User
import com.growthtracker.app.data.repository.GrowthTrackerRepository
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class SearchUiState(
    val searchQuery: String = "",
    val searchResults: List<User> = emptyList(),
    val isLoading: Boolean = false,
    val isSearchVisible: Boolean = false
)

@OptIn(FlowPreview::class)
class SearchViewModel(private val repository: GrowthTrackerRepository) : ViewModel() {
    private val _uiState = MutableStateFlow(SearchUiState())
    val uiState: StateFlow<SearchUiState> = _uiState.asStateFlow()

    private val searchQueryFlow = MutableStateFlow("")

    init {
        // Debounced search
        viewModelScope.launch {
            searchQueryFlow
                .debounce(500)
                .distinctUntilChanged()
                .collectLatest { query ->
                    if (query.isNotEmpty()) {
                        performSearch(query)
                    } else {
                        _uiState.value = _uiState.value.copy(
                            searchResults = emptyList(),
                            isLoading = false
                        )
                    }
                }
        }
    }

    fun updateSearchQuery(query: String) {
        _uiState.value = _uiState.value.copy(searchQuery = query, isLoading = true)
        searchQueryFlow.value = query
    }

    fun showSearch() {
        _uiState.value = _uiState.value.copy(isSearchVisible = true)
    }

    fun hideSearch() {
        _uiState.value = SearchUiState()
    }

    private suspend fun performSearch(query: String) {
        val result = repository.searchUsers(query)
        result.onSuccess { users ->
            _uiState.value = _uiState.value.copy(
                searchResults = users,
                isLoading = false
            )
        }.onFailure {
            _uiState.value = _uiState.value.copy(
                searchResults = emptyList(),
                isLoading = false
            )
        }
    }
}
