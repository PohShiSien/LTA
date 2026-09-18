"""Small, predeclared model comparison for 110 available labelled cycles."""
from __future__ import annotations
import numpy as np
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.feature_selection import VarianceThreshold
from sklearn.preprocessing import StandardScaler
from sklearn.dummy import DummyClassifier
from sklearn.tree import DecisionTreeClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.svm import SVC
from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier, GradientBoostingClassifier


def candidates(seed: int=42) -> dict:
    # Each learned imputer/scaler is fitted within a training fold, never globally.
    def wrap(est, scale=False):
        steps=[('impute',SimpleImputer(strategy='median',keep_empty_features=True)),('variance',VarianceThreshold())]
        if scale: steps.append(('scale',StandardScaler()))
        return Pipeline(steps+[('classifier',est)])
    return {
        'majority_baseline': wrap(DummyClassifier(strategy='most_frequent')),
        'decision_stump': wrap(DecisionTreeClassifier(max_depth=1,random_state=seed)),
        'logistic_regression': wrap(LogisticRegression(C=.1,max_iter=3000,random_state=seed),True),
        # probability=False avoids hidden random calibration folds on dependent cycles.
        'rbf_svm': wrap(SVC(C=1.,kernel='rbf',gamma='scale',probability=False,random_state=seed),True),
        'random_forest': wrap(RandomForestClassifier(n_estimators=300,max_depth=6,min_samples_leaf=2,max_features=.7,n_jobs=1,random_state=seed)),
        'extra_trees': wrap(ExtraTreesClassifier(n_estimators=400,max_depth=8,min_samples_leaf=2,max_features=.7,n_jobs=1,random_state=seed)),
        'gradient_boosting': wrap(GradientBoostingClassifier(n_estimators=150,learning_rate=.04,max_depth=2,min_samples_leaf=3,random_state=seed)),
    }


def abnormal_score(model, X: np.ndarray) -> np.ndarray:
    """An uncalibrated model score, not a probability of mechanical failure."""
    if hasattr(model,'predict_proba'):
        p=model.predict_proba(X); classes=list(model.classes_)
        return p[:,classes.index(1)] if 1 in classes else np.zeros(len(X))
    z=model.decision_function(X)
    return 1/(1+np.exp(-np.clip(z,-40,40)))
